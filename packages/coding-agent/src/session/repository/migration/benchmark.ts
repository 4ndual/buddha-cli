import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const ISSUE_SAMPLE_LIMIT = 200;

export type CorpusKind = "synthetic" | "safe-explicit-copy";

export interface CopiedCorpusAttestation {
	schemaVersion: 1;
	corpusKind: CorpusKind;
	claimScope: "synthetic-generated" | "full-user-corpus" | "partial-explicit-copy";
	allExpectedSourcesEnumerated: boolean;
	sourceLedger: string;
	sourceLedgerSha256: string;
	createdAt: string;
}

export interface InventoryLedgerRecord {
	schemaVersion: number;
	itemId: string;
	rootId: string;
	sourceNamespace: string;
	relativePath: string;
	kind: string;
	classification: { format: string; version?: string; confidence: string; evidence: string[] };
	original: { sha256: string; size: number; mode?: number; mtime?: string; ctime?: string; birthtime?: string };
	snapshotAt: string;
	status: "copied" | "excluded" | "pending" | "quarantined";
	copied?: { path: string; sha256: string; size: number; mode?: number };
	disposition?: { code: string; reason: string; evidence: string[] };
	metadataObservations?: unknown[];
}

export interface NormalizedLedgerRecord {
	schemaVersion: number;
	sourceItemId: string;
	normalizedHash: string;
	originId: string;
}

export interface ImportedLedgerRecord {
	schemaVersion: number;
	sourceItemId: string;
	normalizedHash: string;
	originId: string;
	branchId: string;
	headHash: string;
	contextSupported: boolean;
	unsupportedReason?: string;
	unsupportedEvidence?: string[];
}

export interface DispositionLedgerRecord {
	schemaVersion: number;
	sourceItemId: string;
	status: "quarantined" | "excluded" | "archive-only";
	reason: string;
	evidence: string[];
}

export interface AttachmentLedgerRecord {
	schemaVersion: number;
	sourceItemId: string;
	contentHash: string;
	importedPayloadHash: string;
}

export interface BranchHeadLedgerRecord {
	schemaVersion: number;
	branchId: string;
	expectedHeadHash: string;
	actualHeadHash: string;
}

export interface ContextHashLedgerRecord {
	schemaVersion: number;
	branchId: string;
	leafHash: string;
	contextBuilderVersion: string;
	expectedContextHash: string;
	actualContextHash: string;
}

export interface RollbackDrillReceipt {
	schemaVersion: 1;
	completed: true;
	completedAt: string;
	sourceLedgerSha256: string;
	export: { manifestPath: string; sha256: string; branchContinued: true };
	recovery: {
		manifestPath: string;
		sha256: string;
		reimportOutcome: "extension" | "sibling-fork";
	};
}

export interface AccountingInput {
	copiedCorpusPath: string;
	copyAttestationPath: string;
	sourceLedgerPath: string;
	normalizedLedgerPath: string;
	importedLedgerPath: string;
	dispositionLedgerPath: string;
	branchHeadLedgerPath: string;
	attachmentLedgerPath: string;
	contextHashLedgerPath: string;
	rollbackReceiptPath: string;
	outputDirectory: string;
	partitionCount?: number;
	maxBatchBytes?: number;
	maxRecordsPerPartition?: number;
	maxLineBytes?: number;
}

export interface AccountingIssue {
	code: string;
	key?: string;
	detail: string;
}

export interface AccountingReport {
	schemaVersion: 1;
	createdAt: string;
	corpus: {
		root: string;
		kind: CorpusKind;
		claimScope: CopiedCorpusAttestation["claimScope"];
		sourceLedgerSha256: string;
	};
	ledgerSha256: {
		source: string;
		normalized: string;
		imported: string;
		disposition: string;
		branchHeads: string;
		attachments: string;
		contextHashes: string;
		rollbackReceipt: string;
	};
	bounds: { partitionCount: number; maxBatchBytes: number; maxRecordsPerPartition: number; maxLineBytes: number };
	counts: {
		discovered: number;
		copied: number;
		imported: number;
		dispositioned: number;
		attachments: number;
		branchHeads: number;
		contextHashes: number;
		pending: number;
		failed: number;
	};
	bytes: { discovered: number; copied: number };
	coverage: { byRoot: Record<string, number>; bySourceNamespace: Record<string, number>; byKind: Record<string, number> };
	rollbackDrillVerified: boolean;
	completionBadge: "COMPLETE" | "INCOMPLETE";
	actualCorpusCompletionClaim: boolean;
	issues: AccountingIssue[];
	issueCount: number;
	issueSamplesTruncated: boolean;
}

export interface SyntheticCorpusRecord {
	id: string;
	originId: string;
	branchId: string;
	parentId: string | null;
	sequence: number;
	kind: "message" | "tool-result" | "attachment";
	text: string;
	payload?: string;
}

export type SyntheticProfileName = "1k" | "10x";

export interface SyntheticProfile {
	name: SyntheticProfileName;
	recordCount: number;
	longSessionRecords: number;
	forkEvery: number;
	giantPayloadEvery: number;
	giantPayloadBytes: number;
	concurrentWriteRecords: number;
	concurrentSearches: number;
}

export function syntheticProfile(name: SyntheticProfileName): SyntheticProfile {
	return name === "1k"
		? {
				name,
				recordCount: 1_000,
				longSessionRecords: 500,
				forkEvery: 100,
				giantPayloadEvery: 250,
				giantPayloadBytes: 256 * 1024,
				concurrentWriteRecords: 24,
				concurrentSearches: 24,
			}
		: {
				name,
				recordCount: 10_000,
				longSessionRecords: 5_000,
				forkEvery: 100,
				giantPayloadEvery: 500,
				giantPayloadBytes: 1024 * 1024,
				concurrentWriteRecords: 64,
				concurrentSearches: 64,
			};
}

export async function generateSyntheticBenchmarkCorpus(
	outputPath: string,
	profileName: SyntheticProfileName,
): Promise<{ profile: SyntheticProfile; sha256: string; bytes: number }> {
	const profile = syntheticProfile(profileName);
	await mkdir(path.dirname(outputPath), { recursive: true });
	const handle = await open(outputPath, "w", 0o600);
	const hasher = createHash("sha256");
	let bytes = 0;
	try {
		for (let index = 0; index < profile.recordCount; index++) {
			const inLongSession = index < profile.longSessionRecords;
			const session = inLongSession ? "long" : `session-${Math.floor(index / 50)}`;
			const fork = index > 0 && index % profile.forkEvery === 0 ? `fork-${index}` : "main";
			const giant = index > 0 && index % profile.giantPayloadEvery === 0;
			const record: SyntheticCorpusRecord = {
				id: `${profileName}-${index}`,
				originId: `synthetic:${session}`,
				branchId: `synthetic:${session}:${fork}`,
				parentId: index === 0 ? null : `${profileName}-${index - 1}`,
				sequence: index,
				kind: giant ? "tool-result" : index % 17 === 0 ? "attachment" : "message",
				text: `synthetic searchable message ${index} branch ${fork}`,
				...(giant ? { payload: "x".repeat(profile.giantPayloadBytes) } : {}),
			};
			const line = `${JSON.stringify(record)}\n`;
			hasher.update(line);
			bytes += Buffer.byteLength(line);
			await handle.write(line);
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	return { profile, sha256: hasher.digest("hex"), bytes };
}

export interface BenchmarkAdapter {
	importBatch(records: readonly SyntheticCorpusRecord[]): Promise<void>;
	resetForColdRead(): Promise<void>;
	list(limit: number): Promise<unknown>;
	search(query: string, limit: number): Promise<unknown>;
	readContextTail(branchId: string, limit: number): Promise<unknown>;
	append?(record: SyntheticCorpusRecord): Promise<void>;
	flush(): Promise<void>;
}

export interface BenchmarkInput {
	copiedCorpusPath: string;
	copyAttestationPath: string;
	recordsPath: string;
	outputDirectory: string;
	reportPath: string;
	storagePaths: string[];
	adapter: BenchmarkAdapter;
	adapterLabel: string;
	warmSamples?: number;
	coldSamples?: number;
	batchRecords?: number;
	batchBytes?: number;
	maxRecords?: number;
	maxLineBytes?: number;
	fsyncSamples?: number;
	memorySampleIntervalMs?: number;
	concurrentWrites?: number;
	concurrentSearches?: number;
}

export interface Percentiles {
	p50: number;
	p95: number;
	p99: number;
	min: number;
	max: number;
	samples: number;
}

export interface BenchmarkReport {
	schemaVersion: 1;
	createdAt: string;
	adapterLabel: string;
	corpus: {
		root: string;
		kind: CorpusKind;
		claimScope: CopiedCorpusAttestation["claimScope"];
		recordsPath: string;
		records: number;
		bytes: number;
		actualEightMonthCorpusMeasured: boolean;
	};
	bounds: { batchRecords: number; batchBytes: number; maxRecords: number; maxLineBytes: number };
	latencyMs: {
		cold: { list: Percentiles; search: Percentiles; context: Percentiles; method: "adapter-reset" };
		warm: { list: Percentiles; search: Percentiles; context: Percentiles };
		fsync: Percentiles;
		concurrentSearch: Percentiles;
	};
	import: { seconds: number; recordsPerSecond: number; mebibytesPerSecond: number; batches: number; largestBatchRecords: number; largestBatchBytes: number };
	concurrency: { writes: number; searches: number; seconds: number; errors: number };
	cpu: { userMs: number; systemMs: number };
	memory: { baselineRssBytes: number; peakRssBytes: number; baselinePssBytes: number | null; peakPssBytes: number | null };
	disk: { beforeBytes: number; afterBytes: number; growthBytes: number; categories: Record<string, { beforeBytes: number; afterBytes: number; growthBytes: number }> };
}

interface PartitionEnvelope {
	t: "source" | "normalized" | "imported" | "disposition" | "attachment" | "requirement" | "head" | "context";
	v: unknown;
}

interface IssueCollector {
	count: number;
	samples: AccountingIssue[];
	add(code: string, detail: string, key?: string): void;
}

function issueCollector(): IssueCollector {
	return {
		count: 0,
		samples: [],
		add(code, detail, key) {
			this.count++;
			if (this.samples.length < ISSUE_SAMPLE_LIMIT) this.samples.push({ code, detail, ...(key ? { key } : {}) });
		},
	};
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && HASH_PATTERN.test(value);
}

function increment(target: Record<string, number>, key: string): void {
	target[key] = (target[key] ?? 0) + 1;
}

function percentile(values: number[]): Percentiles {
	if (values.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, samples: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
	return { p50: at(0.5), p95: at(0.95), p99: at(0.99), min: sorted[0]!, max: sorted.at(-1)!, samples: sorted.length };
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = createHash("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function* jsonLines<T>(filePath: string, maxLineBytes: number): AsyncGenerator<T> {
	const decoder = new TextDecoder();
	let pending = "";
	let lineNumber = 0;
	for await (const chunk of Bun.file(filePath).stream()) {
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			lineNumber++;
			if (Buffer.byteLength(line) > maxLineBytes) throw new Error(`${filePath}:${lineNumber}: line exceeds ${maxLineBytes} bytes`);
			if (line.trim()) yield JSON.parse(line) as T;
			newline = pending.indexOf("\n");
		}
		if (Buffer.byteLength(pending) > maxLineBytes) throw new Error(`${filePath}:${lineNumber + 1}: line exceeds ${maxLineBytes} bytes`);
	}
	pending += decoder.decode();
	if (pending.trim()) {
		lineNumber++;
		if (Buffer.byteLength(pending) > maxLineBytes) throw new Error(`${filePath}:${lineNumber}: line exceeds ${maxLineBytes} bytes`);
		yield JSON.parse(pending) as T;
	}
}

async function containedPath(root: string, candidate: string, mustExist = true): Promise<string> {
	const absoluteRoot = await realpath(root);
	const absoluteCandidate = mustExist ? await realpath(candidate) : path.resolve(candidate);
	const relative = path.relative(absoluteRoot, absoluteCandidate);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return absoluteCandidate;
	throw new Error(`Path escapes explicit copied/owned root: ${candidate}`);
}

async function loadAttestation(root: string, attestationPath: string, sourceLedgerPath?: string): Promise<CopiedCorpusAttestation> {
	await containedPath(root, attestationPath);
	const value = JSON.parse(await readFile(attestationPath, "utf8")) as CopiedCorpusAttestation;
	if (value.schemaVersion !== 1 || !["synthetic", "safe-explicit-copy"].includes(value.corpusKind)) throw new Error("Invalid copied-corpus attestation");
	if (!isHash(value.sourceLedgerSha256)) throw new Error("Attestation source ledger hash is invalid");
	const declaredLedger = await containedPath(root, path.resolve(root, value.sourceLedger));
	if (sourceLedgerPath && declaredLedger !== (await containedPath(root, sourceLedgerPath))) throw new Error("Attestation names a different source ledger");
	if ((await sha256File(declaredLedger)) !== value.sourceLedgerSha256) throw new Error("Copied-corpus source ledger hash mismatch");
	return value;
}

function partitionFor(key: string, count: number): number {
	const digest = createHash("sha256").update(key).digest();
	return digest.readUInt32BE(0) % count;
}

async function partitionLedger<T>(
	ledgerPath: string,
	partitionDirectory: string,
	prefix: string,
	partitionCount: number,
	maxBatchBytes: number,
	maxLineBytes: number,
	keyOf: (record: T) => string,
	envelopes: (record: T) => PartitionEnvelope[],
	onRecord?: (record: T) => Promise<void> | void,
): Promise<void> {
	let batchBytes = 0;
	const batches = new Map<string, string[]>();
	const flush = async () => {
		for (const [filePath, lines] of batches) await appendFile(filePath, lines.join(""), { encoding: "utf8", mode: 0o600 });
		batches.clear();
		batchBytes = 0;
	};
	for await (const record of jsonLines<T>(ledgerPath, maxLineBytes)) {
		await onRecord?.(record);
		const key = keyOf(record);
		if (!key) throw new Error(`${ledgerPath}: record is missing its accounting key`);
		for (const envelope of envelopes(record)) {
			const filePath = path.join(partitionDirectory, `${prefix}-${partitionFor(key, partitionCount)}.jsonl`);
			const line = `${JSON.stringify(envelope)}\n`;
			const lineBytes = Buffer.byteLength(line);
			if (lineBytes > maxBatchBytes) throw new Error(`${ledgerPath}: accounting projection exceeds batch bound`);
			if (batchBytes > 0 && batchBytes + lineBytes > maxBatchBytes) await flush();
			const lines = batches.get(filePath) ?? [];
			lines.push(line);
			batches.set(filePath, lines);
			batchBytes += lineBytes;
		}
		if (batchBytes >= maxBatchBytes) await flush();
	}
	await flush();
}

function validEvidence(evidence: unknown): boolean {
	return Array.isArray(evidence) && evidence.length > 0 && evidence.every(item => typeof item === "string" && item.length > 0);
}

async function verifyRollback(root: string, receiptPath: string, ledgerHash: string, issues: IssueCollector): Promise<boolean> {
	let receipt: RollbackDrillReceipt;
	try {
		receipt = JSON.parse(await readFile(await containedPath(root, receiptPath), "utf8")) as RollbackDrillReceipt;
	} catch (error) {
		issues.add("rollback-receipt-unreadable", String(error));
		return false;
	}
	if (receipt.schemaVersion !== 1 || receipt.completed !== true || receipt.sourceLedgerSha256 !== ledgerHash) {
		issues.add("rollback-receipt-invalid", "Rollback receipt is incomplete or tied to another source ledger");
		return false;
	}
	if (!receipt.export.branchContinued || !["extension", "sibling-fork"].includes(receipt.recovery.reimportOutcome)) {
		issues.add("rollback-drill-incomplete", "Export continuation and reimport outcome are required");
		return false;
	}
	for (const part of [receipt.export, receipt.recovery]) {
		if (!isHash(part.sha256)) {
			issues.add("rollback-evidence-hash-invalid", part.manifestPath);
			return false;
		}
		try {
			const evidencePath = await containedPath(root, path.resolve(root, part.manifestPath));
			if ((await sha256File(evidencePath)) !== part.sha256) {
				issues.add("rollback-evidence-hash-mismatch", part.manifestPath);
				return false;
			}
		} catch (error) {
			issues.add("rollback-evidence-unreadable", String(error));
			return false;
		}
	}
	return true;
}

export async function accountCopiedCorpus(input: AccountingInput): Promise<AccountingReport> {
	const partitionCount = input.partitionCount ?? 64;
	const maxBatchBytes = input.maxBatchBytes ?? 1024 * 1024;
	const maxRecordsPerPartition = input.maxRecordsPerPartition ?? 100_000;
	const maxLineBytes = input.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	if (partitionCount < 4 || partitionCount > 4096) throw new Error("partitionCount must be between 4 and 4096");
	if (maxBatchBytes < 4096) throw new Error("maxBatchBytes must be at least 4096");
	const root = await realpath(input.copiedCorpusPath);
	await mkdir(input.outputDirectory, { recursive: true });
	const outputDirectory = await realpath(input.outputDirectory);
	if (outputDirectory === root) throw new Error("Accounting scratch/output must not overwrite the copied corpus");
	for (const sourcePath of [
		input.sourceLedgerPath,
		input.normalizedLedgerPath,
		input.importedLedgerPath,
		input.dispositionLedgerPath,
		input.branchHeadLedgerPath,
		input.attachmentLedgerPath,
		input.contextHashLedgerPath,
		input.rollbackReceiptPath,
	]) await containedPath(root, sourcePath);
	const attestation = await loadAttestation(root, input.copyAttestationPath, input.sourceLedgerPath);
	const ledgerHash = await sha256File(input.sourceLedgerPath);
	const [normalizedLedgerHash, importedLedgerHash, dispositionLedgerHash, branchHeadLedgerHash, attachmentLedgerHash, contextHashLedgerHash, rollbackReceiptHash] = await Promise.all([
		sha256File(input.normalizedLedgerPath),
		sha256File(input.importedLedgerPath),
		sha256File(input.dispositionLedgerPath),
		sha256File(input.branchHeadLedgerPath),
		sha256File(input.attachmentLedgerPath),
		sha256File(input.contextHashLedgerPath),
		sha256File(input.rollbackReceiptPath),
	]);
	const scratch = path.join(outputDirectory, `.accounting-${randomUUID()}`);
	await mkdir(scratch, { recursive: true });
	const issues = issueCollector();
	const counts = { discovered: 0, copied: 0, imported: 0, dispositioned: 0, attachments: 0, branchHeads: 0, contextHashes: 0, pending: 0, failed: 0 };
	const bytes = { discovered: 0, copied: 0 };
	const coverage = { byRoot: {} as Record<string, number>, bySourceNamespace: {} as Record<string, number>, byKind: {} as Record<string, number> };
	try {
		await partitionLedger<InventoryLedgerRecord>(input.sourceLedgerPath, scratch, "source", partitionCount, maxBatchBytes, maxLineBytes, row => row.itemId, row => [{ t: "source", v: row }], async row => {
			counts.discovered++;
			bytes.discovered += Number(row.original?.size ?? 0);
			increment(coverage.byRoot, row.rootId || "<missing>");
			increment(coverage.bySourceNamespace, row.sourceNamespace || "<missing>");
			increment(coverage.byKind, row.kind || "<missing>");
			if (!isHash(row.original?.sha256) || !Number.isSafeInteger(row.original?.size) || row.original.size < 0) issues.add("invalid-source-record", "Original hash/size is invalid", row.itemId);
			if (row.status === "pending") counts.pending++;
			if (row.status === "copied") {
				counts.copied++;
				bytes.copied += Number(row.copied?.size ?? 0);
				if (!row.copied || row.copied.sha256 !== row.original.sha256 || row.copied.size !== row.original.size) {
					issues.add("copy-accounting-mismatch", "Copied hash/size does not match the immutable original ledger", row.itemId);
				} else {
					try {
						const copiedPath = await containedPath(root, path.resolve(root, row.copied.path));
						const copiedStat = await stat(copiedPath);
						if (copiedStat.size !== row.copied.size || (await sha256File(copiedPath)) !== row.copied.sha256) issues.add("copied-file-hash-mismatch", row.copied.path, row.itemId);
					} catch (error) {
						issues.add("copied-file-unreadable", String(error), row.itemId);
					}
				}
			}
		});
		await partitionLedger<NormalizedLedgerRecord>(input.normalizedLedgerPath, scratch, "source", partitionCount, maxBatchBytes, maxLineBytes, row => row.sourceItemId, row => [{ t: "normalized", v: row }]);
		await partitionLedger<ImportedLedgerRecord>(input.importedLedgerPath, scratch, "source", partitionCount, maxBatchBytes, maxLineBytes, row => row.sourceItemId, row => [{ t: "imported", v: row }]);
		await partitionLedger<ImportedLedgerRecord>(input.importedLedgerPath, scratch, "branch", partitionCount, maxBatchBytes, maxLineBytes, row => row.branchId, row => [{ t: "requirement", v: row }]);
		await partitionLedger<DispositionLedgerRecord>(input.dispositionLedgerPath, scratch, "source", partitionCount, maxBatchBytes, maxLineBytes, row => row.sourceItemId, row => [{ t: "disposition", v: row }]);
		await partitionLedger<AttachmentLedgerRecord>(input.attachmentLedgerPath, scratch, "source", partitionCount, maxBatchBytes, maxLineBytes, row => row.sourceItemId, row => [{ t: "attachment", v: row }]);
		await partitionLedger<BranchHeadLedgerRecord>(input.branchHeadLedgerPath, scratch, "branch", partitionCount, maxBatchBytes, maxLineBytes, row => row.branchId, row => [{ t: "head", v: row }]);
		await partitionLedger<ContextHashLedgerRecord>(input.contextHashLedgerPath, scratch, "branch", partitionCount, maxBatchBytes, maxLineBytes, row => row.branchId, row => [{ t: "context", v: row }]);

		for (let index = 0; index < partitionCount; index++) {
			const sourceFile = path.join(scratch, `source-${index}.jsonl`);
			const grouped = new Map<string, { source: InventoryLedgerRecord[]; normalized: NormalizedLedgerRecord[]; imported: ImportedLedgerRecord[]; disposition: DispositionLedgerRecord[]; attachment: AttachmentLedgerRecord[] }>();
			let sourcePartitionRecords = 0;
			if (await Bun.file(sourceFile).exists()) for await (const envelope of jsonLines<PartitionEnvelope>(sourceFile, maxLineBytes)) {
				sourcePartitionRecords++;
				if (sourcePartitionRecords > maxRecordsPerPartition) throw new Error(`Source partition ${index} exceeded ${maxRecordsPerPartition} records`);
				const value = envelope.v as { itemId?: string; sourceItemId?: string };
				const key = value.itemId ?? value.sourceItemId ?? "";
				const current = grouped.get(key) ?? { source: [], normalized: [], imported: [], disposition: [], attachment: [] };
				(current[envelope.t as keyof typeof current] as unknown[]).push(envelope.v);
				grouped.set(key, current);
				if (grouped.size > maxRecordsPerPartition) throw new Error(`Source partition ${index} exceeded ${maxRecordsPerPartition} unique keys`);
			}
			for (const [key, group] of grouped) {
				if (group.source.length !== 1) {
					issues.add(group.source.length === 0 ? "unknown-source-reference" : "duplicate-source-item", `Found ${group.source.length} source records`, key);
					continue;
				}
				const source = group.source[0]!;
				if (source.status === "pending") issues.add("pending-source-item", "Inventory item has no final disposition", key);
				const inventoryDisposition = source.status === "excluded" || source.status === "quarantined";
				if (inventoryDisposition && (!source.disposition?.reason || !validEvidence(source.disposition.evidence))) issues.add("inventory-disposition-without-evidence", source.status, key);
				if (group.disposition.length > 1 || group.normalized.length > 1 || group.imported.length > 1 || group.attachment.length > 1) issues.add("duplicate-accounting-record", "A source item has duplicate stage receipts", key);
				const disposition = group.disposition[0];
				if (disposition && (!disposition.reason || !validEvidence(disposition.evidence))) issues.add("disposition-without-evidence", disposition.status, key);
				if ((inventoryDisposition || disposition) && (group.normalized.length > 0 || group.imported.length > 0 || group.attachment.length > 0)) issues.add("ambiguous-source-disposition", "Source has both an import receipt and a quarantine/exclusion disposition", key);
				if (inventoryDisposition || disposition) {
					counts.dispositioned++;
					continue;
				}
				if (source.status !== "copied") {
					issues.add("unaccounted-source-status", source.status, key);
					continue;
				}
				if (source.kind === "attachment") {
					const attachment = group.attachment[0];
					if (!attachment || attachment.contentHash !== source.original.sha256 || attachment.importedPayloadHash !== attachment.contentHash) issues.add("attachment-accounting-mismatch", "Attachment is absent or payload hash differs", key);
					else counts.attachments++;
					continue;
				}
				const normalized = group.normalized[0];
				const imported = group.imported[0];
				if (!normalized || !imported) {
					issues.add("missing-import-mapping", "Copied source lacks normalized/imported mapping or disposition", key);
					continue;
				}
				if (!isHash(normalized.normalizedHash) || normalized.normalizedHash !== imported.normalizedHash || normalized.originId !== imported.originId) issues.add("import-mapping-mismatch", "Normalized and imported identities/hashes differ", key);
				else counts.imported++;
			}

			const branchFile = path.join(scratch, `branch-${index}.jsonl`);
			const branches = new Map<string, { requirement: ImportedLedgerRecord[]; head: BranchHeadLedgerRecord[]; context: ContextHashLedgerRecord[] }>();
			let branchPartitionRecords = 0;
			if (await Bun.file(branchFile).exists()) for await (const envelope of jsonLines<PartitionEnvelope>(branchFile, maxLineBytes)) {
				branchPartitionRecords++;
				if (branchPartitionRecords > maxRecordsPerPartition) throw new Error(`Branch partition ${index} exceeded ${maxRecordsPerPartition} records`);
				const value = envelope.v as { branchId: string };
				const current = branches.get(value.branchId) ?? { requirement: [], head: [], context: [] };
				(current[envelope.t as keyof typeof current] as unknown[]).push(envelope.v);
				branches.set(value.branchId, current);
				if (branches.size > maxRecordsPerPartition) throw new Error(`Branch partition ${index} exceeded ${maxRecordsPerPartition} unique keys`);
			}
			for (const [branchId, branch] of branches) {
				if (branch.requirement.length === 0) {
					issues.add("orphan-branch-receipt", "Branch receipt has no imported mapping", branchId);
					continue;
				}
				if (branch.head.length !== 1) {
					issues.add("branch-head-receipt-count", `Found ${branch.head.length} receipts`, branchId);
				} else {
					const receipt = branch.head[0]!;
					if (!isHash(receipt.expectedHeadHash) || receipt.expectedHeadHash !== receipt.actualHeadHash || branch.requirement.some(required => required.headHash !== receipt.actualHeadHash)) {
						issues.add("branch-head-mismatch", "Imported and verified heads differ", branchId);
					} else {
						counts.branchHeads++;
					}
				}
				for (const required of branch.requirement) {
					if (!required.contextSupported) {
						if (!required.unsupportedReason || !validEvidence(required.unsupportedEvidence)) issues.add("unsupported-context-without-evidence", "Unsupported context requires reason/evidence", branchId);
						continue;
					}
					const matches = branch.context.filter(receipt => receipt.leafHash === required.headHash);
					if (matches.length !== 1 || matches[0]!.expectedContextHash !== matches[0]!.actualContextHash || !isHash(matches[0]!.actualContextHash)) issues.add("context-hash-mismatch", "Supported leaf lacks one matching deterministic context receipt", branchId);
					else counts.contextHashes++;
				}
			}
		}
		const rollbackDrillVerified = await verifyRollback(root, input.rollbackReceiptPath, ledgerHash, issues);
		if (!attestation.allExpectedSourcesEnumerated) issues.add("source-scope-incomplete", "Copy attestation does not certify that all expected roots/profiles/harnesses/repository artifacts were enumerated");
		counts.failed = issues.count;
		const complete = issues.count === 0 && counts.pending === 0 && rollbackDrillVerified;
		const report: AccountingReport = {
			schemaVersion: 1,
			createdAt: new Date().toISOString(),
			corpus: { root, kind: attestation.corpusKind, claimScope: attestation.claimScope, sourceLedgerSha256: ledgerHash },
			ledgerSha256: {
				source: ledgerHash,
				normalized: normalizedLedgerHash,
				imported: importedLedgerHash,
				disposition: dispositionLedgerHash,
				branchHeads: branchHeadLedgerHash,
				attachments: attachmentLedgerHash,
				contextHashes: contextHashLedgerHash,
				rollbackReceipt: rollbackReceiptHash,
			},
			bounds: { partitionCount, maxBatchBytes, maxRecordsPerPartition, maxLineBytes },
			counts,
			bytes,
			coverage,
			rollbackDrillVerified,
			completionBadge: complete ? "COMPLETE" : "INCOMPLETE",
			actualCorpusCompletionClaim: complete && attestation.corpusKind === "safe-explicit-copy" && attestation.claimScope === "full-user-corpus",
			issues: issues.samples,
			issueCount: issues.count,
			issueSamplesTruncated: issues.count > issues.samples.length,
		};
		await writeFile(path.join(outputDirectory, "accounting-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		return report;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function linuxPssBytes(): Promise<number | null> {
	try {
		const text = await readFile(`/proc/${process.pid}/smaps_rollup`, "utf8");
		const match = /^Pss:\s+(\d+)\s+kB$/m.exec(text);
		return match ? Number(match[1]) * 1024 : null;
	} catch {
		return null;
	}
}

function diskCategory(filePath: string): string {
	const name = path.basename(filePath).toLowerCase();
	if (name.includes("wal")) return "wal";
	if (name.includes("index") || name.includes("fts")) return "index";
	if (name.endsWith(".db") || name.includes("turso")) return "database";
	return "other";
}

async function diskSnapshot(paths: string[]): Promise<{ total: number; categories: Record<string, number> }> {
	let total = 0;
	const categories: Record<string, number> = {};
	const visit = async (entryPath: string): Promise<void> => {
		let metadata;
		try { metadata = await stat(entryPath); } catch { return; }
		if (metadata.isDirectory()) {
			for (const entry of await readdir(entryPath)) await visit(path.join(entryPath, entry));
		} else if (metadata.isFile()) {
			total += metadata.size;
			const category = diskCategory(entryPath);
			categories[category] = (categories[category] ?? 0) + metadata.size;
		}
	};
	for (const entryPath of paths) await visit(entryPath);
	return { total, categories };
}

async function timed(operation: () => Promise<unknown>): Promise<number> {
	const started = performance.now();
	await operation();
	return performance.now() - started;
}

async function fsyncLatencies(directory: string, samples: number): Promise<number[]> {
	const probe = path.join(directory, `.fsync-probe-${randomUUID()}`);
	const handle = await open(probe, "w", 0o600);
	const values: number[] = [];
	try {
		for (let index = 0; index < samples; index++) {
			await handle.write(`${index}:${"x".repeat(4096)}\n`);
			const started = performance.now();
			await handle.sync();
			values.push(performance.now() - started);
		}
	} finally {
		await handle.close();
		await rm(probe, { force: true });
	}
	return values;
}

export async function runBoundedMigrationBenchmark(input: BenchmarkInput): Promise<BenchmarkReport> {
	const root = await realpath(input.copiedCorpusPath);
	const attestation = await loadAttestation(root, input.copyAttestationPath);
	const recordsPath = await containedPath(root, input.recordsPath);
	await mkdir(input.outputDirectory, { recursive: true });
	const outputDirectory = await realpath(input.outputDirectory);
	const reportPath = await containedPath(outputDirectory, input.reportPath, false);
	for (const storagePath of input.storagePaths) await containedPath(outputDirectory, storagePath, false);
	const warmSamples = input.warmSamples ?? 30;
	const coldSamples = input.coldSamples ?? 10;
	const batchRecords = input.batchRecords ?? 500;
	const batchBytes = input.batchBytes ?? 8 * 1024 * 1024;
	const maxRecords = input.maxRecords ?? 100_000;
	const maxLineBytes = input.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	for (const [name, value, min, max] of [
		["warmSamples", warmSamples, 1, 10_000], ["coldSamples", coldSamples, 1, 1_000], ["batchRecords", batchRecords, 1, 100_000],
		["batchBytes", batchBytes, 4096, 256 * 1024 * 1024], ["maxRecords", maxRecords, 1, 10_000_000],
	] as const) if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
	const diskBefore = await diskSnapshot(input.storagePaths);
	const baselineRss = process.memoryUsage.rss();
	const baselinePss = await linuxPssBytes();
	let peakRss = baselineRss;
	let peakPss = baselinePss;
	const sampler = setInterval(async () => {
		peakRss = Math.max(peakRss, process.memoryUsage.rss());
		const pss = await linuxPssBytes();
		if (pss !== null) peakPss = Math.max(peakPss ?? 0, pss);
	}, input.memorySampleIntervalMs ?? 10);
	const cpuBefore = process.cpuUsage();
	let records = 0;
	let bytes = 0;
	let batches = 0;
	let largestBatchRecords = 0;
	let largestBatchBytes = 0;
	const importStarted = performance.now();
	let batch: SyntheticCorpusRecord[] = [];
	let currentBatchBytes = 0;
	const importBatch = async () => {
		if (batch.length === 0) return;
		await input.adapter.importBatch(batch);
		batches++;
		largestBatchRecords = Math.max(largestBatchRecords, batch.length);
		largestBatchBytes = Math.max(largestBatchBytes, currentBatchBytes);
		batch = [];
		currentBatchBytes = 0;
	};
	try {
		for await (const record of jsonLines<SyntheticCorpusRecord>(recordsPath, maxLineBytes)) {
			const recordBytes = Buffer.byteLength(JSON.stringify(record)) + 1;
			if (recordBytes > batchBytes) throw new Error(`Record ${record.id} is ${recordBytes} bytes and exceeds the explicit ${batchBytes}-byte batch bound`);
			if (batch.length >= batchRecords || currentBatchBytes + recordBytes > batchBytes) await importBatch();
			batch.push(record);
			currentBatchBytes += recordBytes;
			records++;
			bytes += recordBytes;
			if (records > maxRecords) throw new Error(`Corpus exceeds explicit ${maxRecords}-record bound`);
		}
		await importBatch();
		await input.adapter.flush();
		const importSeconds = (performance.now() - importStarted) / 1000;
		const sampleOperation = async (cold: boolean, samples: number, operation: () => Promise<unknown>): Promise<number[]> => {
			const output: number[] = [];
			for (let index = 0; index < samples; index++) {
				if (cold) await input.adapter.resetForColdRead();
				output.push(await timed(operation));
			}
			return output;
		};
		const queryBranch = "synthetic:long:main";
		const coldList = await sampleOperation(true, coldSamples, () => input.adapter.list(100));
		const coldSearch = await sampleOperation(true, coldSamples, () => input.adapter.search("searchable", 20));
		const coldContext = await sampleOperation(true, coldSamples, () => input.adapter.readContextTail(queryBranch, 500));
		const warmList = await sampleOperation(false, warmSamples, () => input.adapter.list(100));
		const warmSearch = await sampleOperation(false, warmSamples, () => input.adapter.search("searchable", 20));
		const warmContext = await sampleOperation(false, warmSamples, () => input.adapter.readContextTail(queryBranch, 500));
		const concurrentWrites = Math.min(input.concurrentWrites ?? 24, 128);
		const concurrentSearches = Math.min(input.concurrentSearches ?? 24, 128);
		const concurrentLatencies: number[] = [];
		let concurrencyErrors = 0;
		const concurrencyStarted = performance.now();
		const work: Promise<void>[] = [];
		for (let index = 0; index < concurrentWrites; index++) if (input.adapter.append) {
			const record: SyntheticCorpusRecord = { id: `concurrent-${index}`, originId: "synthetic:concurrent", branchId: "synthetic:concurrent:main", parentId: index ? `concurrent-${index - 1}` : null, sequence: index, kind: "message", text: `concurrent write ${index}` };
			work.push(input.adapter.append(record).catch(() => { concurrencyErrors++; }));
		}
		for (let index = 0; index < concurrentSearches; index++) work.push(timed(() => input.adapter.search(`concurrent ${index % 4}`, 20)).then(value => { concurrentLatencies.push(value); }).catch(() => { concurrencyErrors++; }));
		await Promise.all(work);
		await input.adapter.flush();
		const concurrencySeconds = (performance.now() - concurrencyStarted) / 1000;
		const fsync = await fsyncLatencies(outputDirectory, input.fsyncSamples ?? 20);
		const cpu = process.cpuUsage(cpuBefore);
		clearInterval(sampler);
		peakRss = Math.max(peakRss, process.memoryUsage.rss());
		const finalPss = await linuxPssBytes();
		if (finalPss !== null) peakPss = Math.max(peakPss ?? 0, finalPss);
		const diskAfter = await diskSnapshot(input.storagePaths);
		const categoryNames = new Set([...Object.keys(diskBefore.categories), ...Object.keys(diskAfter.categories)]);
		const categories: Record<string, { beforeBytes: number; afterBytes: number; growthBytes: number }> = {};
		for (const category of categoryNames) {
			const beforeBytes = diskBefore.categories[category] ?? 0;
			const afterBytes = diskAfter.categories[category] ?? 0;
			categories[category] = { beforeBytes, afterBytes, growthBytes: afterBytes - beforeBytes };
		}
		const report: BenchmarkReport = {
			schemaVersion: 1,
			createdAt: new Date().toISOString(),
			adapterLabel: input.adapterLabel,
			corpus: { root, kind: attestation.corpusKind, claimScope: attestation.claimScope, recordsPath, records, bytes, actualEightMonthCorpusMeasured: attestation.corpusKind === "safe-explicit-copy" && attestation.claimScope === "full-user-corpus" && attestation.allExpectedSourcesEnumerated },
			bounds: { batchRecords, batchBytes, maxRecords, maxLineBytes },
			latencyMs: {
				cold: { list: percentile(coldList), search: percentile(coldSearch), context: percentile(coldContext), method: "adapter-reset" },
				warm: { list: percentile(warmList), search: percentile(warmSearch), context: percentile(warmContext) },
				fsync: percentile(fsync),
				concurrentSearch: percentile(concurrentLatencies),
			},
			import: { seconds: importSeconds, recordsPerSecond: records / importSeconds, mebibytesPerSecond: bytes / 1024 / 1024 / importSeconds, batches, largestBatchRecords, largestBatchBytes },
			concurrency: { writes: input.adapter.append ? concurrentWrites : 0, searches: concurrentSearches, seconds: concurrencySeconds, errors: concurrencyErrors },
			cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
			memory: { baselineRssBytes: baselineRss, peakRssBytes: peakRss, baselinePssBytes: baselinePss, peakPssBytes: peakPss },
			disk: { beforeBytes: diskBefore.total, afterBytes: diskAfter.total, growthBytes: diskAfter.total - diskBefore.total, categories },
		};
		await mkdir(path.dirname(reportPath), { recursive: true });
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		return report;
	} finally {
		clearInterval(sampler);
	}
}
