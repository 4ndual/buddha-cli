import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	accountCopiedCorpus,
	generateSyntheticBenchmarkCorpus,
	runBoundedMigrationBenchmark,
	syntheticProfile,
	type BenchmarkAdapter,
	type CopiedCorpusAttestation,
	type InventoryLedgerRecord,
	type SyntheticCorpusRecord,
} from "../../../src/session/repository/migration/benchmark";

const fixtureRoot = path.join(import.meta.dir, "fixtures", "turso-benchmark");
const temporaryRoots: string[] = [];

async function sha256(filePath: string): Promise<string> {
	return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeJsonLines(filePath: string, rows: unknown[]): Promise<void> {
	await writeFile(filePath, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
}

async function createCopiedCorpus(missingImport = false): Promise<{
	root: string;
	attestationPath: string;
	accounting: Omit<Parameters<typeof accountCopiedCorpus>[0], "outputDirectory">;
}> {
	const durableParent = process.env.TURSO_PERF_COPIED_CORPUS_ROOT;
	if (durableParent) await mkdir(durableParent, { recursive: true });
	const root = await mkdtemp(path.join(durableParent ?? tmpdir(), missingImport ? "missing-corpus-" : "complete-corpus-"));
	if (!durableParent) temporaryRoots.push(root);
	await mkdir(path.join(root, "copies"));
	const sessionPath = path.join(root, "copies", "session-a.jsonl");
	const attachmentPath = path.join(root, "copies", "attachment.bin");
	await copyFile(path.join(fixtureRoot, "session-a.jsonl"), sessionPath);
	await copyFile(path.join(fixtureRoot, "attachment.bin"), attachmentPath);
	const sessionHash = await sha256(sessionPath);
	const attachmentHash = await sha256(attachmentPath);
	const normalizedHash = createHash("sha256").update("normalized:session-a").digest("hex");
	const headHash = createHash("sha256").update("head:session-a").digest("hex");
	const contextHash = createHash("sha256").update("context:session-a").digest("hex");
	const excludedHash = createHash("sha256").update("excluded synthetic source").digest("hex");
	const sourceRows: InventoryLedgerRecord[] = [
		{
			schemaVersion: 1,
			itemId: "local:omp:session-a",
			rootId: "synthetic-local-profile",
			sourceNamespace: "omp:test",
			relativePath: "session-a.jsonl",
			kind: "session",
			classification: { format: "omp-jsonl", version: "3", confidence: "certain", evidence: ["fixture header"] },
			original: { sha256: sessionHash, size: (await Bun.file(sessionPath).size) },
			snapshotAt: "2026-09-15T00:00:00.000Z",
			status: "copied",
			copied: { path: "copies/session-a.jsonl", sha256: sessionHash, size: (await Bun.file(sessionPath).size) },
		},
		{
			schemaVersion: 1,
			itemId: "repo:github:attachment",
			rootId: "synthetic-github-primary-artifact",
			sourceNamespace: "github:test/repo:release",
			relativePath: "attachment.bin",
			kind: "attachment",
			classification: { format: "binary", confidence: "certain", evidence: ["fixture manifest"] },
			original: { sha256: attachmentHash, size: (await Bun.file(attachmentPath).size) },
			snapshotAt: "2026-09-15T00:00:00.000Z",
			status: "copied",
			copied: { path: "copies/attachment.bin", sha256: attachmentHash, size: (await Bun.file(attachmentPath).size) },
		},
		{
			schemaVersion: 1,
			itemId: "local:foreign:excluded",
			rootId: "synthetic-other-harness",
			sourceNamespace: "foreign:test",
			relativePath: "unsupported.record",
			kind: "session",
			classification: { format: "unknown", confidence: "certain", evidence: ["synthetic unsupported marker"] },
			original: { sha256: excludedHash, size: 25 },
			snapshotAt: "2026-09-15T00:00:00.000Z",
			status: "excluded",
			disposition: { code: "unsupported-synthetic", reason: "Deliberate unsupported fixture", evidence: ["classification evidence retained in ledger"] },
		},
	];
	const sourceLedgerPath = path.join(root, "source-ledger.jsonl");
	await writeJsonLines(sourceLedgerPath, sourceRows);
	const normalizedLedgerPath = path.join(root, "normalized-ledger.jsonl");
	const importedLedgerPath = path.join(root, "imported-ledger.jsonl");
	await writeJsonLines(normalizedLedgerPath, missingImport ? [] : [{ schemaVersion: 1, sourceItemId: "local:omp:session-a", normalizedHash, originId: "omp:test:session-a" }]);
	await writeJsonLines(importedLedgerPath, missingImport ? [] : [{ schemaVersion: 1, sourceItemId: "local:omp:session-a", normalizedHash, originId: "omp:test:session-a", branchId: "branch:session-a", headHash, contextSupported: true }]);
	const dispositionLedgerPath = path.join(root, "disposition-ledger.jsonl");
	await writeJsonLines(dispositionLedgerPath, []);
	const attachmentLedgerPath = path.join(root, "attachment-ledger.jsonl");
	await writeJsonLines(attachmentLedgerPath, [{ schemaVersion: 1, sourceItemId: "repo:github:attachment", contentHash: attachmentHash, importedPayloadHash: attachmentHash }]);
	const branchHeadLedgerPath = path.join(root, "branch-head-ledger.jsonl");
	await writeJsonLines(branchHeadLedgerPath, missingImport ? [] : [{ schemaVersion: 1, branchId: "branch:session-a", expectedHeadHash: headHash, actualHeadHash: headHash }]);
	const contextHashLedgerPath = path.join(root, "context-hash-ledger.jsonl");
	await writeJsonLines(contextHashLedgerPath, missingImport ? [] : [{ schemaVersion: 1, branchId: "branch:session-a", leafHash: headHash, contextBuilderVersion: "test-v1", expectedContextHash: contextHash, actualContextHash: contextHash }]);
	const exportManifestPath = path.join(root, "export-manifest.json");
	const recoveryManifestPath = path.join(root, "recovery-manifest.json");
	await writeFile(exportManifestPath, '{"exported":"branch:session-a","continued":true}\n');
	await writeFile(recoveryManifestPath, '{"reimport":"extension","verified":true}\n');
	const sourceLedgerSha256 = await sha256(sourceLedgerPath);
	const rollbackReceiptPath = path.join(root, "rollback-receipt.json");
	await writeFile(rollbackReceiptPath, JSON.stringify({
		schemaVersion: 1,
		completed: true,
		completedAt: "2026-09-15T00:00:00.000Z",
		sourceLedgerSha256,
		export: { manifestPath: "export-manifest.json", sha256: await sha256(exportManifestPath), branchContinued: true },
		recovery: { manifestPath: "recovery-manifest.json", sha256: await sha256(recoveryManifestPath), reimportOutcome: "extension" },
	}, null, 2));
	const attestationPath = path.join(root, "copied-corpus.json");
	const attestation: CopiedCorpusAttestation = {
		schemaVersion: 1,
		corpusKind: "synthetic",
		claimScope: "synthetic-generated",
		allExpectedSourcesEnumerated: true,
		sourceLedger: "source-ledger.jsonl",
		sourceLedgerSha256,
		createdAt: "2026-09-15T00:00:00.000Z",
	};
	await writeFile(attestationPath, JSON.stringify(attestation, null, 2));
	return {
		root,
		attestationPath,
		accounting: {
			copiedCorpusPath: root,
			copyAttestationPath: attestationPath,
			sourceLedgerPath,
			normalizedLedgerPath,
			importedLedgerPath,
			dispositionLedgerPath,
			branchHeadLedgerPath,
			attachmentLedgerPath,
			contextHashLedgerPath,
			rollbackReceiptPath,
		},
	};
}

class MemoryBenchmarkAdapter implements BenchmarkAdapter {
	readonly records: SyntheticCorpusRecord[] = [];
	readonly batchSizes: number[] = [];
	readonly storagePath: string;

	constructor(storagePath: string) {
		this.storagePath = storagePath;
	}

	async importBatch(records: readonly SyntheticCorpusRecord[]): Promise<void> {
		this.batchSizes.push(records.length);
		this.records.push(...records);
	}

	async resetForColdRead(): Promise<void> {}

	async list(limit: number): Promise<SyntheticCorpusRecord[]> {
		return this.records.slice(0, limit);
	}

	async search(query: string, limit: number): Promise<SyntheticCorpusRecord[]> {
		return this.records.filter(record => record.text.includes(query)).slice(0, limit);
	}

	async readContextTail(branchId: string, limit: number): Promise<SyntheticCorpusRecord[]> {
		return this.records.filter(record => record.branchId === branchId).slice(-limit);
	}

	async append(record: SyntheticCorpusRecord): Promise<void> {
		this.records.push(record);
	}

	async flush(): Promise<void> {
		await writeFile(this.storagePath, `${this.records.length}\n`);
	}
}

afterAll(async () => {
	await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })));
});

describe("offline Turso migration benchmark and accounting", () => {
	it("streams a complete copied-corpus ledger and refuses to claim the user's corpus", async () => {
		const corpus = await createCopiedCorpus();
		const evidenceRoot = process.env.TURSO_PERF_EVIDENCE_DIR ?? await mkdtemp(path.join(tmpdir(), "omp-turso-accounting-report-"));
		if (!process.env.TURSO_PERF_EVIDENCE_DIR) temporaryRoots.push(evidenceRoot);
		await mkdir(evidenceRoot, { recursive: true });
		const report = await accountCopiedCorpus({ ...corpus.accounting, outputDirectory: evidenceRoot, partitionCount: 4, maxBatchBytes: 4096, maxRecordsPerPartition: 100 });
		expect(report.completionBadge).toBe("COMPLETE");
		expect(report.counts).toMatchObject({ discovered: 3, imported: 1, attachments: 1, dispositioned: 1, failed: 0 });
		expect(report.rollbackDrillVerified).toBe(true);
		expect(report.actualCorpusCompletionClaim).toBe(false);
		expect(report.coverage.bySourceNamespace["github:test/repo:release"]).toBe(1);
	});

	it("fails closed when a copied source item has no import mapping", async () => {
		const corpus = await createCopiedCorpus(true);
		const configuredEvidenceRoot = process.env.TURSO_PERF_EVIDENCE_DIR;
		const outputDirectory = configuredEvidenceRoot ? path.join(configuredEvidenceRoot, "missing-item") : await mkdtemp(path.join(tmpdir(), "omp-turso-missing-report-"));
		if (!configuredEvidenceRoot) temporaryRoots.push(outputDirectory);
		await mkdir(outputDirectory, { recursive: true });
		const report = await accountCopiedCorpus({ ...corpus.accounting, outputDirectory, partitionCount: 4, maxBatchBytes: 4096, maxRecordsPerPartition: 100 });
		expect(report.completionBadge).toBe("INCOMPLETE");
		expect(report.actualCorpusCompletionClaim).toBe(false);
		expect(report.issues.some(issue => issue.code === "missing-import-mapping")).toBe(true);
	});

	it("measures synthetic import, cold/warm reads, concurrency, resources and bounded batches", async () => {
		expect(syntheticProfile("10x").recordCount).toBe(10_000);
		const profileName = process.env.TURSO_PERF_PROFILE === "10x" ? "10x" : "1k";
		const profile = syntheticProfile(profileName);
		const corpus = await createCopiedCorpus();
		const recordsPath = path.join(corpus.root, `synthetic-${profileName}.jsonl`);
		const generated = await generateSyntheticBenchmarkCorpus(recordsPath, profileName);
		expect(generated.profile.recordCount).toBe(profile.recordCount);
		const evidenceRoot = process.env.TURSO_PERF_EVIDENCE_DIR ?? await mkdtemp(path.join(tmpdir(), "omp-turso-benchmark-report-"));
		if (!process.env.TURSO_PERF_EVIDENCE_DIR) temporaryRoots.push(evidenceRoot);
		await mkdir(evidenceRoot, { recursive: true });
		const storagePath = path.join(evidenceRoot, `synthetic-storage-${profileName}.bytes`);
		const adapter = new MemoryBenchmarkAdapter(storagePath);
		const report = await runBoundedMigrationBenchmark({
			copiedCorpusPath: corpus.root,
			copyAttestationPath: corpus.attestationPath,
			recordsPath,
			outputDirectory: evidenceRoot,
			reportPath: path.join(evidenceRoot, `benchmark-report-${profileName}.json`),
			storagePaths: [storagePath],
			adapter,
			adapterLabel: "in-memory-test-adapter (harness proof; not Turso engine data)",
			warmSamples: 3,
			coldSamples: 2,
			batchRecords: 7,
			batchBytes: profileName === "10x" ? 2 * 1024 * 1024 : 512 * 1024,
			maxRecords: profile.recordCount,
			fsyncSamples: 3,
			concurrentWrites: 4,
			concurrentSearches: 4,
		});
		expect(report.corpus.records).toBe(profile.recordCount);
		expect(report.corpus.actualEightMonthCorpusMeasured).toBe(false);
		expect(report.import.largestBatchRecords).toBeLessThanOrEqual(7);
		expect(report.import.largestBatchBytes).toBeLessThanOrEqual(report.bounds.batchBytes);
		expect(Math.max(...adapter.batchSizes)).toBeLessThanOrEqual(7);
		expect(report.latencyMs.warm.search.samples).toBe(3);
		expect(report.latencyMs.cold.context.samples).toBe(2);
		expect(report.latencyMs.fsync.samples).toBe(3);
		expect(report.concurrency).toMatchObject({ writes: 4, searches: 4, errors: 0 });
		expect(report.memory.peakRssBytes).toBeGreaterThanOrEqual(report.memory.baselineRssBytes);
		expect(report.disk.growthBytes).toBeGreaterThanOrEqual(0);
	});
});
