#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stableJson } from "../inventory";

interface CorpusItem {
	namespace: string;
	relativePath: string;
	bytes: number;
	sha256?: string;
	disposition: "copied" | "excluded" | "quarantined";
}

interface CorpusManifest {
	schemaVersion: number;
	backupRoot: string;
	summary: { copied: number; excluded: number; quarantined: number };
	items: CorpusItem[];
}

const [manifestArgument, deletionReceiptArgument, outputArgument] = process.argv.slice(2);
if (!manifestArgument || !deletionReceiptArgument || !outputArgument) {
	throw new Error("Usage: bun plan-bounded-import.ts SHARED_MANIFEST DELETION_RECEIPT OUTPUT_JSON");
}

const manifestPath = await fs.realpath(manifestArgument);
const manifestText = await fs.readFile(manifestPath, "utf8");
const manifestSha256 = new Bun.CryptoHasher("sha256").update(manifestText).digest("hex");
if (manifestSha256 !== "740e312259166e50003d90eef41eeda86ad65f5bf0d1054b6c879d7333bfb82b") {
	throw new Error(`Unexpected shared manifest: ${manifestSha256}`);
}
const manifest = JSON.parse(manifestText) as CorpusManifest;
const copied = manifest.items
	.filter((item) => item.disposition === "copied")
	.sort((left, right) => `${left.namespace}/${left.relativePath}`.localeCompare(`${right.namespace}/${right.relativePath}`));
if (copied.some((item) => !item.sha256)) throw new Error("Copied item lacks a content hash");
const inputBytes = copied.reduce((sum, item) => sum + item.bytes, 0);
if (copied.length !== manifest.summary.copied || inputBytes !== 40_716_213_247) throw new Error("Shared corpus accounting changed");
const largestItemBytes = copied.reduce((maximum, item) => Math.max(maximum, item.bytes), 0);
const zeroByteItems = copied.filter((item) => item.bytes === 0).length;

const deletionReceiptPath = path.resolve(deletionReceiptArgument);
const deletionReceiptText = await fs.readFile(deletionReceiptPath, "utf8");
const deletionReceipt = JSON.parse(deletionReceiptText) as {
	approvedBy: string;
	deleted: { files: number; apparentBytes: number };
	preserved: { files: number; apparentBytes: number };
};
if (deletionReceipt.approvedBy !== "WCDBMigrationCoordinator2.WCDBSafetyFinal" || deletionReceipt.deleted.files !== 1458) {
	throw new Error("Approved reclaim receipt is incomplete");
}

const filesystem = await fs.statfs(path.dirname(path.resolve(outputArgument)));
const availableBytes = filesystem.bavail * filesystem.bsize;
const totalBytes = filesystem.blocks * filesystem.bsize;
const estimatedDatabaseBytes = Math.ceil(inputBytes * 1.25);
const estimatedIndexBytes = Math.ceil(inputBytes * 0.35);
const legacyWalBytes = Math.ceil(inputBytes * 0.1);
const legacyNormalizedBytes = Math.ceil(inputBytes * 1.1);
const legacyMutablePeakBytes = legacyNormalizedBytes + estimatedDatabaseBytes + estimatedIndexBytes + legacyWalBytes;
const transactionByteLimit = 64 * 1024 * 1024;
const streamingTransactions = Math.ceil(inputBytes / transactionByteLimit);
const streamingReceiptBytes = streamingTransactions * 4096;
const checkpointedWalBytes = transactionByteLimit * 2;
const partitionByteLimit = 4 * 1024 * 1024 * 1024;
const partitions = Math.ceil(legacyNormalizedBytes / partitionByteLimit);
const partitionReceiptBytes = partitions * 64 * 1024;
const itemReceiptBytes = copied.length * 4096;

const approaches = [
	{
		id: "no-extra-copy-in-place-staging",
		durability: {
			publication: "Create and completely verify the mandatory normalized OMP JSONL stage in one unpublished team-owned generation, then write one WCDB staging database beside it; close, FULL-checkpoint, verify, atomically rename each phase, and fsync the parent.",
			checkpoint: "Normalization and database import both commit at most 64 MiB of source bytes; a durable item receipt records source hash, normalized JSONL/identity/raw outputs, committed database counters, and graph/accounting verification.",
			resume: "Resume normalization or DB import from its committed item/byte cursor; uncommitted filesystem output stays unpublished and uncommitted WAL is recovered before the next batch.",
			noMerge: "The separate normalized stage preserves every origin/version/branch identity; database expected-head conflicts create siblings and never merge content.",
		},
		dryRun: { items: copied.length, inputBytes, largestItemBytes, transactionByteLimit, transactions: streamingTransactions, itemReceiptBytes },
		peakComponents: {
			mandatoryNormalizedStageBytes: legacyNormalizedBytes,
			databaseBytes: estimatedDatabaseBytes,
			indexBytes: estimatedIndexBytes,
			walBytes: legacyWalBytes,
			receiptReserveBytes: itemReceiptBytes,
			duplicateSourceCopyBytes: 0,
			publicationCopyBytes: 0,
		},
		peakBytes: legacyNormalizedBytes + estimatedDatabaseBytes + estimatedIndexBytes + legacyWalBytes + itemReceiptBytes,
	},
	{
		id: "byte-bounded-streaming-transactions",
		durability: {
			publication: "First publish the complete mandatory normalized OMP JSONL+identity+raw/attachment generation, then stream it into one unpublished profile database and publish only after close/checkpoint and complete reconciliation.",
			checkpoint: "Bound both normalization and DB import to 64 MiB transactions and reserve one 4 KiB cursor/commit receipt per transaction.",
			resume: "Cursor is (phase, manifest sequence, source byte offset, source SHA-256); oversized files are chunked, and an item completes only after normalized outputs and database graph/payload hashes verify.",
			noMerge: "The normalized stage preserves identities; DB transactions append immutable payload/event rows and expected-head CAS keeps divergent heads as siblings.",
		},
		dryRun: { items: copied.length, inputBytes, largestItemBytes, transactionByteLimit, transactionsPerPhase: streamingTransactions, oversizedItemsStreamed: copied.filter((item) => item.bytes > transactionByteLimit).length },
		peakComponents: {
			mandatoryNormalizedStageBytes: legacyNormalizedBytes,
			databaseBytes: estimatedDatabaseBytes,
			indexBytes: estimatedIndexBytes,
			walAndCheckpointWindowBytes: checkpointedWalBytes,
			receiptReserveBytes: streamingReceiptBytes,
			duplicateSourceCopyBytes: 0,
			publicationCopyBytes: 0,
		},
		peakBytes: legacyNormalizedBytes + estimatedDatabaseBytes + estimatedIndexBytes + checkpointedWalBytes + streamingReceiptBytes,
	},
	{
		id: "checkpointed-partitions-generations",
		durability: {
			publication: "Publish the mandatory normalized OMP JSONL stage as immutable <=4 GiB generations, then import every generation into one unpublished profile database; generations are staging boundaries, never database shards.",
			checkpoint: "Reserve a 64 KiB chained manifest per normalized generation with every source range, JSONL/identity/raw/attachment hash, durable byte cursor, database counters, and previous-generation hash.",
			resume: "Resume at the first unpublished normalized generation or 64 MiB cursor within it; after all normalized generations exist, resume one-database import by generation and item receipt.",
			noMerge: "There is one database per profile. Normalized generation boundaries do not assign graph ownership; immutable origin/version/branch identities enter the same database and divergence remains sibling branches.",
		},
		dryRun: { items: copied.length, inputBytes, mandatoryNormalizedBytes: legacyNormalizedBytes, largestItemBytes, normalizedGenerationByteLimit: partitionByteLimit, normalizedGenerations: partitions, transactionByteLimit, oversizedItemsSplitAcrossNormalizedGenerations: copied.filter((item) => item.bytes > partitionByteLimit).length },
		peakComponents: {
			mandatoryNormalizedStageBytes: legacyNormalizedBytes,
			singleProfileDatabaseBytes: estimatedDatabaseBytes,
			indexBytes: estimatedIndexBytes,
			walAndCheckpointWindowBytes: checkpointedWalBytes,
			generationReceiptReserveBytes: partitionReceiptBytes,
			duplicateSourceCopyBytes: 0,
			publicationCopyBytes: 0,
		},
		peakBytes: legacyNormalizedBytes + estimatedDatabaseBytes + estimatedIndexBytes + checkpointedWalBytes + partitionReceiptBytes,
	},
];
const withCapacity = approaches.map((approach) => ({
	...approach,
	availableBytes,
	requiredAdditionalBytes: Math.max(0, approach.peakBytes - availableBytes),
	remainingBytesAtEstimatedPeak: Math.max(0, availableBytes - approach.peakBytes),
	capacityEstimateFits: approach.peakBytes <= availableBytes,
}));
const receipt = {
	schema: "omp.wcdb.bounded-full-import-strategies.v1",
	observedAt: new Date().toISOString(),
	inputs: {
		sharedManifest: manifestPath,
		sharedManifestSha256: manifestSha256,
		copiedItems: copied.length,
		copiedBytes: inputBytes,
		zeroByteItems,
		largestItemBytes,
		deletionReceipt: deletionReceiptPath,
		deletionReceiptSha256: new Bun.CryptoHasher("sha256").update(deletionReceiptText).digest("hex"),
	},
	filesystem: {
		totalBytes,
		availableBytes,
		blockSize: filesystem.bsize,
		freeBlocksAvailableToUnprivilegedProcess: filesystem.bavail,
		source: "node:fs/promises statfs on team-owned output filesystem",
	},
	calibration: {
		source: "Previously accepted WCDB capacity model, recalculated against the independently rehashed 40,716,213,247-byte corpus",
		databaseFactor: "ceil(inputBytes * 1.25)",
		indexFactor: "ceil(inputBytes * 0.35)",
		legacyWalFactor: "ceil(inputBytes * 0.10)",
		legacyNormalizedFactor: "ceil(inputBytes * 1.10)",
		estimatedDatabaseBytes,
		estimatedIndexBytes,
		legacyWalBytes,
		legacyNormalizedBytes,
		legacyMutablePeakBytes,
		legacyRequiredAdditionalBytes: Math.max(0, legacyMutablePeakBytes - availableBytes),
	},
	approaches: withCapacity,
	decision: {
		fullImportExecuted: false,
		capacityOnly: "All three plan-compliant approaches retain the mandatory complete normalized stage and remain capacity-blocked; each reports its exact modeled additional bytes.",
		blockedBy: [
			"No full-corpus importer has produced measured database/index amplification for this corpus; the 1.25/0.35 factors remain estimates, so preflight cannot prove the actual peak safe.",
			"The synchronous FFI path lacks cancellation/crash isolation; database mode remains disabled by contract.",
		],
		productionOrConfigurationMutation: false,
	},
};
await fs.writeFile(path.resolve(outputArgument), stableJson(receipt));
process.stdout.write(stableJson(receipt));
