#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { accountCorpus } from "./corpus";
import { runConcurrencyChild, runConcurrentWorkload } from "./concurrency";
import { produceFixtureRows } from "./fixtures";
import { gitHeadCommit } from "./git-pin";
import { runNativeBridge } from "./native";
import { DIRECT_SQLITE_SETTINGS, runDirectSqlite } from "./sqlite";
import type { DirectSqliteResult } from "./sqlite";
import type { BenchmarkReceipt, EngineReceipt, MetricReceipt } from "./types";
import { distribution, fsyncLatency, machineDetails, writeJsonAtomic } from "./util";

interface Options {
	full: boolean;
	corpusRoot: string;
	artifactRoot: string;
	databaseRoot: string;
	inventoryLedgerPath?: string;
	normalizationLedgerPath?: string;
	nativeGatePath: string;
	iterations: number;
	maxInputBytes: number;
	maxRecordBytes: number;
	scale: number;
	longestEntries: number;
	forkBranches: number;
	giantOutputBytes: number;
	concurrentOperations: number;
	concurrentByteCap: number;
}

const DEFAULT_TEAM_ROOT = "/home/andual/Projects/.omp-wcdb-team";

function optionValue(name: string): string | undefined {
	const prefix = `--${name}=`;
	const argument = process.argv.slice(2).find(value => value.startsWith(prefix));
	return argument?.slice(prefix.length);
}

function numericOption(name: string, fallback: number): number {
	const value = optionValue(name);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number`);
	return parsed;
}

function parseOptions(): Options {
	const full = process.argv.includes("--full");
	const artifactRoot = optionValue("artifacts") ?? path.join(DEFAULT_TEAM_ROOT, "artifacts/performance");
	return {
		full,
		corpusRoot: optionValue("corpus") ?? path.join(DEFAULT_TEAM_ROOT, "copies"),
		artifactRoot,
		databaseRoot: optionValue("databases") ?? path.join(DEFAULT_TEAM_ROOT, "databases/perf"),
		inventoryLedgerPath: optionValue("inventory-ledger"),
		normalizationLedgerPath:
			optionValue("normalization-ledger") ??
			path.join(DEFAULT_TEAM_ROOT, "staging/normalize/normalization-ledger.7992c8d815d2e597aa2759f7b36f83d28f5f19b4e5dcd765d406225dc7ae6986.json"),
		nativeGatePath: optionValue("native-gate") ?? path.join(DEFAULT_TEAM_ROOT, "artifacts/native/capability-gate.json"),
		iterations: numericOption("iterations", full ? 50 : 3),
		maxInputBytes: numericOption("max-input-bytes", full ? 64 * 1024 ** 3 : 8 * 1024 ** 2),
		maxRecordBytes: numericOption("max-record-bytes", full ? 64 * 1024 ** 2 : 256 * 1024),
		scale: numericOption("scale", full ? 10 : 1),
		longestEntries: numericOption("longest-entries", full ? 5_000 : 32),
		forkBranches: numericOption("fork-branches", full ? 128 : 4),
		giantOutputBytes: numericOption("giant-output-bytes", full ? 8 * 1024 ** 2 : 64 * 1024),
		concurrentOperations: numericOption("concurrent-operations", full ? 1_000 : 8),
		concurrentByteCap: numericOption("concurrent-byte-cap", full ? 64 * 1024 ** 2 : 512 * 1024),
	};
}

function pressureAverage(text: string, kind: "some" | "full"): number {
	const line = text.split("\n").find(value => value.startsWith(`${kind} `));
	const match = line?.match(/avg10=([0-9.]+)/);
	return match ? Number(match[1]) : 0;
}

async function assertFullRunPressureSafe(): Promise<void> {
	const ioPressure = await Bun.file("/proc/pressure/io").text();
	const some = pressureAverage(ioPressure, "some");
	const full = pressureAverage(ioPressure, "full");
	if (some >= 10 || full >= 10) {
		throw new Error(`full benchmark refused while IO pressure is high (some avg10=${some}, full avg10=${full}); retry in a coordinated low-IO window`);
	}
}


function directTax(direct: EngineReceipt, native: EngineReceipt, settingsMatched: boolean): BenchmarkReceipt["directSqliteTax"] {
	if (native.status !== "measured") {
		return { status: "blocked", reason: native.reason ?? "native capability gate did not pass", matchedSettings: false, metrics: {} };
	}
	if (!settingsMatched) return { status: "blocked", reason: "WCDB and direct SQLite settings are not identical", matchedSettings: false, metrics: {} };
	const metrics: BenchmarkReceipt["directSqliteTax"]["metrics"] = {};
	for (const [name, directMetric] of Object.entries(direct.metrics)) {
		const nativeMetric = native.metrics[name];
		const directMs = directMetric.latency?.p50Ms;
		const nativeMs = nativeMetric?.latency?.p50Ms;
		if (directMs === undefined || nativeMs === undefined || directMs === 0) continue;
		metrics[name] = { wcdbMs: nativeMs, directSqliteMs: directMs, ratio: nativeMs / directMs };
	}
	if (Object.keys(metrics).length === 0) {
		return { status: "blocked", reason: "matched receipts contain no common latency metrics", matchedSettings: true, metrics };
	}
	return { status: "measured", reason: "WCDB/direct SQLite ratios use identical declared settings and data/query protocol", matchedSettings: true, metrics };
}

async function persistCheckpoint(artifactRoot: string, phase: string, status: string, details: Record<string, unknown> = {}): Promise<void> {
	await writeJsonAtomic(path.join(artifactRoot, "checkpoint.json"), {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		phase,
		status,
		pid: process.pid,
		...details,
	});
}

async function run(): Promise<void> {
	const child = optionValue("child") as "writer" | "search" | undefined;
	if (child) {
		const databasePath = optionValue("database");
		if (!databasePath) throw new Error("concurrency child requires --database");
		const result = await runConcurrencyChild(child, databasePath, numericOption("operations", 10), numericOption("byte-cap", 1024 * 1024));
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(result.error ? 1 : 0);
	}

	const options = parseOptions();
	await fs.mkdir(options.artifactRoot, { recursive: true });
	await fs.mkdir(options.databaseRoot, { recursive: true });
	await persistCheckpoint(options.artifactRoot, "preflight", "running", { full: options.full });
	if (options.full) await assertFullRunPressureSafe();

	const accountingRecordsPath = path.join(options.artifactRoot, "copied-corpus-records.jsonl");
	const corpus = await accountCorpus({
		root: options.corpusRoot,
		recordsPath: accountingRecordsPath,
		inventoryLedgerPath: options.inventoryLedgerPath,
		normalizationLedgerPath: options.normalizationLedgerPath,
		maxInputBytes: options.maxInputBytes,
		maxRecordBytes: options.maxRecordBytes,
	});
	await persistCheckpoint(options.artifactRoot, "accounting", "complete", { corpusStatus: corpus.status, records: corpus.records });

	const native = await runNativeBridge({
		gatePath: options.nativeGatePath,
		corpusRoot: options.corpusRoot,
		databasePath: path.join(options.databaseRoot, "wcdb.sqlite"),
		exportPath: path.join(options.artifactRoot, "wcdb-export"),
		iterations: options.iterations,
		maxInputBytes: options.maxInputBytes,
		maxRecordBytes: options.maxRecordBytes,
		scale: options.scale,
	});
	const filesystem = await fs.statfs(options.databaseRoot);
	const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
	const estimatedFixtureBytes =
		corpus.bytes +
		corpus.records * Math.min(options.maxRecordBytes, 16 * 1024) * options.scale +
		options.longestEntries * 256 +
		options.forkBranches * 8 * 192 +
		options.giantOutputBytes;
	const estimatedRequiredBytes = Math.ceil(estimatedFixtureBytes * 3.2);
	const diskSufficient = freeBytes >= estimatedRequiredBytes;
	const baselineSkipReason =
		native.engine.status !== "measured"
			? "full direct SQLite baseline skipped because the native WCDB capability gate did not pass"
			: `full direct SQLite baseline blocked by disk preflight: ${freeBytes} bytes free, ${estimatedRequiredBytes} bytes conservatively required`;
	const producer = (visit: Parameters<typeof produceFixtureRows>[1]) =>
		produceFixtureRows(
			{
				corpusRoot: options.corpusRoot,
				maxInputBytes: options.maxInputBytes,
				maxRecordBytes: options.maxRecordBytes,
				scale: options.scale,
				longestEntries: options.longestEntries,
				forkBranches: options.forkBranches,
				giantOutputBytes: options.giantOutputBytes,
			},
			visit,
		);
	const baseline: DirectSqliteResult =
		!options.full || (native.engine.status === "measured" && diskSufficient)
			? await runDirectSqlite({
					databasePath: path.join(options.databaseRoot, "direct.sqlite"),
					exportPath: path.join(options.artifactRoot, "direct-baseline-export.jsonl"),
					reimportPath: path.join(options.databaseRoot, "direct-reimport.sqlite"),
					iterations: options.iterations,
					produceRows: producer,
				})
			: {
					engine: {
						status: native.engine.status === "measured" ? "blocked" : "skipped",
						reason: baselineSkipReason,
						engine: "direct-sqlite",
						version: null,
						settings: DIRECT_SQLITE_SETTINGS,
						metrics: {},
						bridgeCallTotal: 0,
					},
					exportRecovery: {
						status: "skipped",
						reason: "direct SQLite export/reimport skipped with the baseline",
						exportSha256: null,
						reimportDatabaseSha256: null,
						rowsExported: 0,
						rowsReimported: 0,
						semanticHashBefore: null,
						semanticHashAfter: null,
					},
					fixtures: {
						actualRows: 0,
						scaledRows: 0,
						longestEntries: 0,
						forkBranches: 0,
						giantOutputBytes: 0,
						inputBytes: 0,
					},
				};
	const direct = baseline.engine;
	await persistCheckpoint(options.artifactRoot, "direct-sqlite", direct.status, {
		rows: baseline.fixtures.actualRows + baseline.fixtures.scaledRows,
	});

	const concurrency: MetricReceipt =
		direct.status === "measured"
			? await runConcurrentWorkload(import.meta.path, path.join(options.databaseRoot, "direct.sqlite"), options.concurrentOperations, options.concurrentByteCap)
			: { status: "skipped", reason: "concurrent direct SQLite workload skipped because matched WCDB comparison is unavailable" };
	const fsyncValues = direct.status === "measured" ? await fsyncLatency(options.databaseRoot, options.iterations) : [];
	const fsync: MetricReceipt =
		fsyncValues.length > 0
			? {
					status: "measured",
					latency: distribution(fsyncValues),
					bridgeCalls: 0,
					operationCalls: options.iterations,
					details: { operation: "FileHandle.sync on a 4 KiB local file", directory: options.databaseRoot },
				}
			: { status: "skipped", reason: "fsync baseline skipped because matched WCDB comparison is unavailable" };
	const tax = directTax(direct, native.engine, native.settingsMatched);
	const nativeRecovery = native.engine.metrics.recovery;
	const exportRecovery: BenchmarkReceipt["exportRecovery"] =
		native.engine.status === "measured" && nativeRecovery?.status === "measured"
			? {
					status: "measured",
					reason: "native WCDB bridge reported verified export/reimport/recovery under the pinned protocol",
					exportSha256: typeof nativeRecovery.details?.exportSha256 === "string" ? nativeRecovery.details.exportSha256 : null,
					reimportDatabaseSha256:
						typeof nativeRecovery.details?.reimportDatabaseSha256 === "string" ? nativeRecovery.details.reimportDatabaseSha256 : null,
					rowsExported: nativeRecovery.rows ?? 0,
					rowsReimported: Number(nativeRecovery.details?.rowsReimported ?? 0),
					semanticHashBefore: typeof nativeRecovery.details?.semanticHashBefore === "string" ? nativeRecovery.details.semanticHashBefore : null,
					semanticHashAfter: typeof nativeRecovery.details?.semanticHashAfter === "string" ? nativeRecovery.details.semanticHashAfter : null,
				}
			: {
					status: "blocked",
					reason: `WCDB recovery drill unavailable; direct SQLite baseline only: ${baseline.exportRecovery.reason}`,
					exportSha256: null,
					reimportDatabaseSha256: null,
					rowsExported: 0,
					rowsReimported: 0,
					semanticHashBefore: null,
					semanticHashAfter: null,
				};
	const fullMeasured =
		options.full &&
		options.scale === 10 &&
		corpus.status === "measured" &&
		native.engine.status === "measured" &&
		tax.status === "measured" &&
		concurrency.status === "measured" &&
		exportRecovery.status === "measured";
	const receipt: BenchmarkReceipt = {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		status: fullMeasured ? "measured" : "blocked",
		machine: await machineDetails(options.databaseRoot),
		pins: {
			harnessCommit: process.env.GIT_COMMIT ?? (await gitHeadCommit(path.resolve(import.meta.dir, "../.."))),
			nativeGatePath: options.nativeGatePath,
			nativeGateSha256: native.gateSha256,
			nativeLibrarySha256: native.librarySha256,
			nativeBuildManifestSha256: native.buildManifestSha256,
			nativeBridgeExecutableSha256: native.bridgeExecutableSha256,
			wcdbCommit: native.wcdbCommit,
			sqliteVersion: native.sqliteVersion,
		},
		limits: {
			maxInputBytes: options.maxInputBytes,
			maxRecordBytes: options.maxRecordBytes,
			iterations: options.iterations,
			scale: options.scale,
		},
		corpus,
		fixtures: {
			actualRows: baseline.fixtures.actualRows,
			scaledRows: baseline.fixtures.scaledRows,
			longestEntries: baseline.fixtures.longestEntries,
			forkBranches: baseline.fixtures.forkBranches,
			giantOutputBytes: baseline.fixtures.giantOutputBytes,
		},
		engines: [direct, native.engine],
		directSqliteTax: tax,
		concurrency,
		fsync,
		exportRecovery,
		claims: [
			{
				gate: "benchmark-scope",
				status: options.full ? "measured" : "skipped",
				evidence: options.full ? "full workload requested after IO pressure gate" : "smoke profile only; performance goals are not evaluated",
			},
			{
				gate: "disk-capacity",
				status: options.full ? (diskSufficient ? "measured" : "blocked") : "skipped",
				evidence: `${freeBytes} bytes free; conservative full-run requirement ${estimatedRequiredBytes} bytes`,
			},
			{ gate: "full-copied-corpus-accounting", status: corpus.status, evidence: corpus.reason ?? accountingRecordsPath },
			{ gate: "direct-sqlite-baseline-export-reimport", status: baseline.exportRecovery.status, evidence: baseline.exportRecovery.reason },
			{ gate: "matched-wcdb-direct-sqlite-tax", status: tax.status, evidence: tax.reason },
			{ gate: "wcdb-export-recovery", status: exportRecovery.status, evidence: exportRecovery.reason },
			{
				gate: "performance-goals",
				status: fullMeasured ? "measured" : "blocked",
				evidence: fullMeasured ? "all required full-run gates produced data" : "goals cannot pass until copied-corpus, native, matched-tax, and recovery gates all measure successfully",
			},
		],
	};
	const receiptPath = path.join(options.artifactRoot, options.full ? "benchmark-receipt.json" : "smoke-receipt.json");
	await writeJsonAtomic(receiptPath, receipt);
	await persistCheckpoint(options.artifactRoot, "complete", receipt.status, { receiptPath });
	process.stdout.write(`${JSON.stringify({ receiptPath, status: receipt.status, native: native.engine.status, corpus: corpus.status })}\n`);
}

await run().catch(async error => {
	const artifactRoot = optionValue("artifacts") ?? path.join(DEFAULT_TEAM_ROOT, "artifacts/performance");
	try {
		await persistCheckpoint(artifactRoot, "failed", "blocked", { error: error instanceof Error ? error.message : String(error) });
	} catch {
		// Preserve the original failure if checkpoint persistence also fails.
	}
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
