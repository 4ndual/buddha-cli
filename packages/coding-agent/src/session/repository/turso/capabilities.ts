import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import {
	openLocalTursoDatabase,
	TURSO_DATABASE_PACKAGE_VERSION,
	TURSO_NATIVE_PACKAGE_VERSION,
	TURSO_VALIDATED_BUN_VERSION,
	type TursoDatabase,
} from "./database";
import {
	deleteTursoSearchDocument,
	optimizeTursoSearchIndex,
	searchTursoDocuments,
	upsertTursoSearchDocument,
	verifyTursoSearchIndex,
} from "./fts";
import { TURSO_SCHEMA_VERSION } from "./schema";

export type TursoCapabilityStatus = "supported" | "unsupported" | "unknown";

export interface TursoCapabilityResult {
	status: TursoCapabilityStatus;
	mandatory: boolean;
	detail: string;
	evidence: Record<string, unknown>;
	error?: string;
}

export interface TursoFeasibilityApproach {
	approach: string;
	outcome: TursoCapabilityStatus;
	detail: string;
	evidence: Record<string, unknown>;
}

export interface TursoCapabilityReport {
	reportVersion: 1;
	generatedAt: string;
	databaseModeEnabled: boolean;
	engine: {
		package: "@tursodatabase/database";
		packageVersion: string;
		nativePackage: "@tursodatabase/database-linux-x64-gnu";
		nativePackageVersion: string;
		schemaVersion: number;
	};
	runtime: {
		bunVersion: string;
		validatedBunVersion: string;
		platform: string;
		arch: string;
	};
	probeRoot: string;
	capabilities: Record<string, TursoCapabilityResult>;
	unsupportedGuarantees: string[];
	unknownGuarantees: string[];
	mandatoryFailures: string[];
	nativeLoadApproaches: Array<{ approach: string; outcome: TursoCapabilityStatus; detail: string }>;
	ftsRankingPrefixApproaches: TursoFeasibilityApproach[];
}

export interface ProbeTursoCapabilitiesOptions {
	databaseRoot: string;
	offlineInstallEvidencePath?: string;
	reportPath?: string;
}

type CapabilityEvidence = { detail: string; evidence?: Record<string, unknown> };

type NativeDatabase = {
	open: boolean;
	exec(sql: string, options?: { queryTimeout?: number }): Promise<void>;
	run(sql: string, ...parameters: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
	get<T>(sql: string, ...parameters: unknown[]): Promise<T | undefined>;
	all<T>(sql: string, ...parameters: unknown[]): Promise<T[]>;
	backup(filename: string, options: Record<string, unknown>): unknown;
	transactionAsync<T>(operation: (transaction: NativeTransaction) => Promise<T>): (() => Promise<T>) & {
		immediate: () => Promise<T>;
	};
	close(): Promise<void>;
};


class CapabilityProbeFailure extends Error {
	readonly evidence: Record<string, unknown>;

	constructor(message: string, evidence: Record<string, unknown>) {
		super(message);
		this.name = "CapabilityProbeFailure";
		this.evidence = evidence;
	}
}
type NativeTransaction = {
	exec(sql: string): Promise<void>;
	run(sql: string, ...parameters: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
};

type NativeConnect = (
	filename: string,
	options?: { experimental?: string[]; timeout?: number; defaultQueryTimeout?: number },
) => Promise<NativeDatabase>;

async function loadNativeConnect(): Promise<NativeConnect> {
	// Runtime selection must not load the optional native driver on JSONL-only startup.
	const module = await import("@tursodatabase/database");
	return module.connect as unknown as NativeConnect;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function waitForFile(filename: string, timeoutMs: number): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await Bun.file(filename).exists()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for child-process marker: ${filename}`);
}

async function probeFtsRankingPrefixApproaches(
	connect: NativeConnect,
	probeRoot: string,
): Promise<TursoFeasibilityApproach[]> {
	const specifications = [
		{
			approach: "default-tokenizer-documented-wildcard",
			indexSql: "CREATE INDEX documents_fts ON documents USING fts (text)",
			rankingQuery: "database",
			prefixQuery: "data*",
		},
		{
			approach: "weighted-index-column-qualified-grammar",
			indexSql: "CREATE INDEX documents_fts ON documents USING fts (text) WITH (weights = 'text=2.0')",
			rankingQuery: "text:database",
			prefixQuery: "text:data*",
		},
		{
			approach: "ngram-tokenizer-autocomplete-query",
			indexSql: "CREATE INDEX documents_fts ON documents USING fts (text) WITH (tokenizer = 'ngram')",
			rankingQuery: "database",
			prefixQuery: "data",
		},
		{
			approach: "per-column-default-tokenizer-syntax",
			indexSql: "CREATE INDEX documents_fts ON documents USING fts (text WITH tokenizer=default)",
			rankingQuery: "database",
			prefixQuery: "data*",
		},
	] as const;
	const approaches: TursoFeasibilityApproach[] = [];
	for (const specification of specifications) {
		const databasePath = path.join(probeRoot, `fts-approach-${specification.approach}.db`);
		let database: NativeDatabase | undefined;
		try {
			database = await connect(databasePath, { experimental: ["index_method"] });
			await database.exec("CREATE TABLE documents(id TEXT PRIMARY KEY, text TEXT NOT NULL)");
			await database.exec(specification.indexSql);
			await database.exec(
				"INSERT INTO documents VALUES ('one', 'database database database local storage');" +
					"INSERT INTO documents VALUES ('two', 'database guide for embedded systems')",
			);
			const ranked = await database.all<{ id: string; score: number }>(
				"SELECT id, fts_score(text, ?) AS score FROM documents WHERE fts_match(text, ?) ORDER BY score DESC",
				specification.rankingQuery,
				specification.rankingQuery,
			);
			const prefix = await database.all<{ id: string }>(
				"SELECT id FROM documents WHERE fts_match(text, ?) ORDER BY id",
				specification.prefixQuery,
			);
			const rankingSupported =
				ranked.length === 2 &&
				ranked.every(row => Number.isFinite(Number(row.score))) &&
				new Set(ranked.map(row => Number(row.score))).size === 2;
			const prefixSupported = prefix.length === 2;
			approaches.push({
				approach: specification.approach,
				outcome: rankingSupported && prefixSupported ? "supported" : "unsupported",
				detail: `ranking ${rankingSupported ? "differentiated scores" : "did not differentiate scores"}; prefix ${
					prefixSupported ? "matched both documents" : "did not match both documents"
				}`,
				evidence: {
					indexSql: specification.indexSql,
					rankingQuery: specification.rankingQuery,
					prefixQuery: specification.prefixQuery,
					ranked,
					prefix,
					rankingSupported,
					prefixSupported,
				},
			});
		} catch (error) {
			approaches.push({
				approach: specification.approach,
				outcome: "unsupported",
				detail: "Pinned engine rejected the documented index/query approach",
				evidence: {
					indexSql: specification.indexSql,
					rankingQuery: specification.rankingQuery,
					prefixQuery: specification.prefixQuery,
					error: errorMessage(error),
				},
			});
		} finally {
			if (database?.open) await database.close();
		}
	}
	return approaches;
}

async function insertFtsFixture(database: TursoDatabase): Promise<void> {
	await database.transactionAsync(async transaction => {
		await transaction.run(
			"INSERT INTO origins(origin_id, source_namespace, native_id, created_at) VALUES (?, ?, ?, ?)",
			"origin-capability",
			"probe",
			"native-capability",
			1,
		);
		for (const [index, text] of [
			"database database database local storage",
			"database guide for embedded systems",
			"full text search with a local engine",
		].entries()) {
			const number = index + 1;
			await transaction.run(
				`INSERT INTO payloads(payload_id, content_hash, codec, codec_version, uncompressed_length, stored_length, chunk_count, media_type, created_at)
				 VALUES (?, ?, 'identity', 1, ?, ?, 0, 'application/json', ?)`,
				`payload-${number}`,
				`payload-hash-${number}`,
				text.length,
				text.length,
				number,
			);
			await transaction.run(
				`INSERT INTO events(event_hash, origin_id, parent_hash, native_entry_id, kind, timestamp, payload_id, canonicalizer_version, canonical_length)
				 VALUES (?, 'origin-capability', NULL, ?, 'message', ?, ?, 1, ?)`,
				`event-${number}`,
				`native-${number}`,
				number,
				`payload-${number}`,
				text.length,
			);
			await upsertTursoSearchDocument(transaction, {
				eventHash: `event-${number}`,
				originId: "origin-capability",
				role: number === 2 ? "assistant" : "user",
				eventTime: number,
				text,
			});
		}
	});
}

export async function probeTursoCapabilities(options: ProbeTursoCapabilitiesOptions): Promise<TursoCapabilityReport> {
	if (!path.isAbsolute(options.databaseRoot)) throw new Error("Capability database root must be absolute");
	await mkdir(options.databaseRoot, { recursive: true });
	const probeRoot = path.join(options.databaseRoot, `capability-${Date.now()}-${process.pid}`);
	await mkdir(probeRoot, { recursive: false });
	const capabilities: Record<string, TursoCapabilityResult> = {};
	const nativeLoadApproaches: TursoCapabilityReport["nativeLoadApproaches"] = [];

	const check = async (name: string, mandatory: boolean, operation: () => Promise<CapabilityEvidence>): Promise<boolean> => {
		try {
			const result = await operation();
			capabilities[name] = {
				status: "supported",
				mandatory,
				detail: result.detail,
				evidence: result.evidence ?? {},
			};
			return true;
		} catch (error) {
			capabilities[name] = {
				status: "unsupported",
				mandatory,
				detail: "Executed probe did not establish the guarantee",
				evidence: error instanceof CapabilityProbeFailure ? error.evidence : {},
				error: errorMessage(error),
			};
			return false;
		}
	};

	if (options.offlineInstallEvidencePath) {
		await check("offlineInstallAndLocalUse", true, async () => {
			const evidence = (await Bun.file(options.offlineInstallEvidencePath!).json()) as {
				status?: string;
				runtime?: { bunVersion?: string };
				package?: { version?: string };
				nativePackage?: { version?: string; binarySha256?: string };
				install?: { command?: string; networkProxiesForcedToRefuse?: boolean };
				localUse?: { queryResult?: { value?: string } };
			};
			if (
				evidence.status !== "supported" ||
				evidence.runtime?.bunVersion !== TURSO_VALIDATED_BUN_VERSION ||
				evidence.package?.version !== TURSO_DATABASE_PACKAGE_VERSION ||
				evidence.nativePackage?.version !== TURSO_NATIVE_PACKAGE_VERSION ||
				!evidence.nativePackage.binarySha256 ||
				evidence.install?.command !== "bun install --offline" ||
				evidence.install.networkProxiesForcedToRefuse !== true ||
				evidence.localUse?.queryResult?.value !== "verified"
			) {
				throw new CapabilityProbeFailure("Offline install evidence is missing or does not match pinned runtime artifacts", {
					evidencePath: options.offlineInstallEvidencePath!,
				});
			}
			return {
				detail: "Fresh staging install from the provisioned Bun cache and local native query passed with network proxies denied",
				evidence: {
					evidencePath: options.offlineInstallEvidencePath!,
					nativeBinarySha256: evidence.nativePackage.binarySha256,
					cacheWasPrepopulated: true,
				},
			};
		});
	} else {
		capabilities.offlineInstallAndLocalUse = {
			status: "unknown",
			mandatory: true,
			detail: "No executed offline-install evidence was supplied",
			evidence: {},
		};
	}

	const databasePath = path.join(probeRoot, "sessions.turso.db");
	let database: TursoDatabase | undefined;
	const nativeLoaded = await check("nativeLoading", true, async () => {
		const connect = await loadNativeConnect();
		const directPath = path.join(probeRoot, "native-load.db");
		const direct = await connect(directPath, { experimental: ["index_method", "multiprocess_wal"] });
		await direct.exec("CREATE TABLE load_probe(value TEXT NOT NULL); INSERT INTO load_probe VALUES ('bun-native-ok')");
		const row = await direct.get<{ value: string }>("SELECT value FROM load_probe");
		await direct.close();
		if (row?.value !== "bun-native-ok") throw new Error("Native query returned an unexpected value");
		nativeLoadApproaches.push({
			approach: "package optional native binding via standard ESM import",
			outcome: "supported",
			detail: "Bun loaded the pinned linux-x64-gnu N-API artifact and used a local file",
		});
		return { detail: "Pinned native N-API package loads and executes under Bun", evidence: { directPath } };
	});
	const ftsRankingPrefixApproaches = nativeLoaded
		? await probeFtsRankingPrefixApproaches(await loadNativeConnect(), probeRoot)
		: [];

	if (nativeLoaded) {
		await check("nativeVersionEnforcement", false, async () => {
			const versionCheckPath = path.join(probeRoot, "native-version-check.db");
			const childCode = `import { connect } from "@tursodatabase/database"; const db=await connect(process.argv[1]); await db.close();`;
			const child = Bun.spawn([process.execPath, "--eval", childCode, versionCheckPath], {
				cwd: process.cwd(),
				env: { ...process.env, NAPI_RS_ENFORCE_VERSION_CHECK: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await child.exited;
			const stderr = await new Response(child.stderr).text();
			if (exitCode !== 0) {
				throw new CapabilityProbeFailure("Package loader rejects its own pinned native package when strict version checking is enabled", {
					exitCode,
					stderr,
					packageVersion: TURSO_DATABASE_PACKAGE_VERSION,
					nativePackageVersion: TURSO_NATIVE_PACKAGE_VERSION,
				});
			}
			return { detail: "Package and native binding versions pass the N-API loader's strict version check" };
		});
		await check("localFileOnlyGuard", true, async () => {
			for (const rejectedPath of [
				"libsql://example.turso.io/db",
				"https://example.turso.io/db",
				"file:relative.db",
				":memory:",
				path.join(path.dirname(options.databaseRoot), "outside.db"),
			]) {
				let rejected = false;
				try {
					await openLocalTursoDatabase({ path: rejectedPath, allowedRoot: probeRoot });
				} catch {
					rejected = true;
				}
				if (!rejected) throw new Error(`Unsafe database target was accepted: ${rejectedPath}`);
			}
			return {
				detail: "URLs, cloud-style schemes, memory databases, and root escapes are rejected before connection",
				evidence: { rejectedTargets: 5 },
			};
		});

		await check("schemaAndConnection", true, async () => {
			database = await openLocalTursoDatabase({ path: databasePath, allowedRoot: probeRoot, migrate: true });
			if (database.schemaVersion !== TURSO_SCHEMA_VERSION) throw new Error("Schema migration did not reach pinned version");
			return {
				detail: "Local connection enabled foreign keys and applied every pinned migration transactionally",
				evidence: { databasePath, schemaVersion: database.schemaVersion },
			};
		});
	}

	if (!database) {
		for (const [name, mandatory] of [
			["shutdown", true],
			["preparedStatements", true],
			["preparedStatementInterrupt", false],
			["preparedQueryStreaming", true],
			["cancellation", true],
			["largeIntegers", true],
			["transactions", true],
			["readSnapshots", true],
			["foreignKeys", true],
			["multiprocessLocking", true],
			["checkpoint", true],
			["restartRecovery", true],
			["durableCommitRecovery", true],
			["nativeFtsIndex", true],
			["ftsPhraseAndFilters", true],
			["ftsRanking", true],
			["ftsPrefix", true],
			["ftsUpdateDelete", true],
			["ftsTransactionConsistency", true],
			["ftsOptimizeAndBoundedIteration", true],
		] as const) {
			capabilities[name] = {
				status: "unknown",
				mandatory,
				detail: "Prerequisite native connection or schema gate failed",
				evidence: {},
			};
		}
	} else {
		await check("shutdown", true, async () => {
			const shutdownPath = path.join(probeRoot, "shutdown.db");
			const connection = await openLocalTursoDatabase({ path: shutdownPath, allowedRoot: probeRoot });
			await connection.close();
			if (connection.open) throw new Error("Connection still reports open after awaited shutdown");
			const reopened = await openLocalTursoDatabase({
				path: shutdownPath,
				allowedRoot: probeRoot,
				readonly: true,
				fileMustExist: true,
			});
			await reopened.close();
			return { detail: "Awaited close released the connection and the file reopened read-only" };
		});

		await check("preparedStatements", true, async () => {
			const statement = await database!.prepare(
				"INSERT INTO maintenance_state(name, value, updated_at) VALUES (?, ?, ?)",
			);
			const result = await statement.run("prepared-probe", "ok", 1);
			statement.close();
			const row = await database!.get<{ value: string }>(
				"SELECT value FROM maintenance_state WHERE name = ?",
				"prepared-probe",
			);
			if (result.changes !== 1 || row?.value !== "ok") throw new Error("Prepared statement result was not persisted");
			return { detail: "Prepared bind, execute, and query round trip passed", evidence: { changes: result.changes } };
		});
		await check("preparedStatementInterrupt", false, async () => {
			const statement = await database!.prepare("SELECT 1 AS value");
			try {
				statement.interrupt();
			} finally {
				statement.close();
			}
			return { detail: "Prepared statement interrupt API is implemented" };
		});


		await check("preparedQueryStreaming", true, async () => {
			await database!.exec("CREATE TABLE capability_stream(value INTEGER PRIMARY KEY)");
			await database!.transactionAsync(async transaction => {
				for (let value = 0; value < 257; value++) await transaction.run("INSERT INTO capability_stream VALUES (?)", value);
			});
			const statement = await database!.prepare("SELECT value FROM capability_stream ORDER BY value");
			let rows = 0;
			let last = -1;
			for await (const row of statement.iterate<{ value: number | bigint }>()) {
				rows++;
				last = Number(row.value);
			}
			statement.close();
			if (rows !== 257 || last !== 256) throw new Error("Prepared iterator omitted or reordered rows");
			return { detail: "Prepared async iterator streamed all rows in order", evidence: { rows } };
		});

		await check("cancellation", true, async () => {
			await database!.exec("CREATE TABLE capability_numbers(value INTEGER PRIMARY KEY)");
			await database!.transactionAsync(async transaction => {
				for (let value = 0; value < 400; value++) await transaction.run("INSERT INTO capability_numbers VALUES (?)", value);
			});
			const started = performance.now();
			let interrupted = false;
			try {
				await database!.exec(
					"SELECT sum(a.value * b.value * c.value) FROM capability_numbers a, capability_numbers b, capability_numbers c",
					{ queryTimeout: 5 },
				);
			} catch (error) {
				interrupted = /interrupt/i.test(errorMessage(error));
			}
			const elapsedMs = performance.now() - started;
			if (!interrupted) throw new Error("Long query was not interrupted by its deadline");
			return { detail: "Per-query deadline interrupts native execution", evidence: { queryTimeoutMs: 5, elapsedMs } };
		});

		await check("largeIntegers", true, async () => {
			const row = await database!.get<{ value: bigint }>("SELECT CAST('9223372036854775807' AS INTEGER) AS value");
			if (row?.value !== 9_223_372_036_854_775_807n) throw new Error(`64-bit integer changed value or type: ${String(row?.value)}`);
			return { detail: "Signed 64-bit values are returned losslessly as bigint", evidence: { value: row.value.toString() } };
		});

		await check("transactions", true, async () => {
			await database!.exec("CREATE TABLE capability_transactions(value TEXT PRIMARY KEY)");
			try {
				await database!.transactionAsync(async transaction => {
					await transaction.run("INSERT INTO capability_transactions VALUES ('rolled-back')");
					throw new Error("intentional rollback");
				});
			} catch (error) {
				if (!errorMessage(error).includes("intentional rollback")) throw error;
			}
			await database!.transactionAsync(async transaction => {
				await transaction.run("INSERT INTO capability_transactions VALUES ('committed')");
			});
			const rows = await database!.all<{ value: string }>("SELECT value FROM capability_transactions");
			if (rows.length !== 1 || rows[0]?.value !== "committed") throw new Error("Commit/rollback atomicity failed");
			return { detail: "Immediate transactions commit atomically and roll back thrown callbacks", evidence: { rows } };
		});

		await check("readSnapshots", true, async () => {
			await database!.exec("CREATE TABLE capability_snapshot(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO capability_snapshot VALUES (1, 'before')");
			const reader = await openLocalTursoDatabase({
				path: databasePath,
				allowedRoot: probeRoot,
				readonly: true,
				fileMustExist: true,
				migrate: false,
			});
			try {
				await reader.transactionAsync(async transaction => {
					const before = await transaction.get<{ value: string }>("SELECT value FROM capability_snapshot WHERE id = 1");
					await database!.run("UPDATE capability_snapshot SET value = 'after' WHERE id = 1");
					const during = await transaction.get<{ value: string }>("SELECT value FROM capability_snapshot WHERE id = 1");
					if (before?.value !== "before" || during?.value !== "before") throw new Error("Reader snapshot changed during transaction");
				}, "deferred");
				const after = await reader.get<{ value: string }>("SELECT value FROM capability_snapshot WHERE id = 1");
				if (after?.value !== "after") throw new Error("Reader did not observe committed value after snapshot ended");
			} finally {
				await reader.close();
			}
			return { detail: "Concurrent reader retained its snapshot and observed the writer after transaction end" };
		});

		await check("foreignKeys", true, async () => {
			let rejected = false;
			try {
				await database!.run(
					"INSERT INTO source_aliases(source_namespace, native_id, origin_id, observed_at) VALUES ('probe', 'missing', 'missing-origin', 1)",
				);
			} catch (error) {
				rejected = /foreign key/i.test(errorMessage(error));
			}
			if (!rejected) throw new Error("Foreign-key violation was not rejected");
			return { detail: "Foreign-key enforcement is enabled and rejects missing parents" };
		});

		await check("multiprocessLocking", true, async () => {
			await database!.exec("CREATE TABLE capability_locking(value TEXT PRIMARY KEY)");
			const marker = path.join(probeRoot, "writer-locked.marker");
			const childCode = `import { connect } from "@tursodatabase/database"; const db=await connect(process.argv[1],{experimental:["multiprocess_wal"],timeout:5000}); const tx=db.transactionAsync(async t=>{await t.run("INSERT INTO capability_locking VALUES ('child')"); await Bun.write(process.argv[2],"locked"); await Bun.sleep(300)}); await tx.immediate(); await db.close();`;
			const child = Bun.spawn([process.execPath, "--eval", childCode, databasePath, marker], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			});
			await waitForFile(marker, 5_000);
			const started = performance.now();
			await database!.run("INSERT INTO capability_locking VALUES ('parent')");
			const waitedMs = performance.now() - started;
			const exitCode = await child.exited;
			if (exitCode !== 0) throw new Error(`Lock-holder child exited ${exitCode}: ${await new Response(child.stderr).text()}`);
			const rows = await database!.all<{ value: string }>("SELECT value FROM capability_locking ORDER BY value");
			if (rows.length !== 2 || waitedMs < 150) throw new Error("Second process did not serialize behind the active writer");
			return { detail: "Separate Bun processes serialized writers without losing either commit", evidence: { waitedMs, rows } };
		});

		await check("checkpoint", true, async () => {
			const result = await database!.checkpoint();
			if (result.busy !== 0) throw new Error("Checkpoint reported busy");
			return { detail: "Full WAL checkpoint completed with no busy handles", evidence: { ...result } };
		});

		await check("restartRecovery", true, async () => {
			const restartPath = path.join(probeRoot, "restart.db");
			const first = await openLocalTursoDatabase({ path: restartPath, allowedRoot: probeRoot });
			await first.run("INSERT INTO maintenance_state(name, value, updated_at) VALUES ('restart', 'persisted', 1)");
			await first.close();
			const reopened = await openLocalTursoDatabase({
				path: restartPath,
				allowedRoot: probeRoot,
				readonly: true,
				fileMustExist: true,
			});
			const row = await reopened.get<{ value: string }>("SELECT value FROM maintenance_state WHERE name = 'restart'");
			await reopened.close();
			if (row?.value !== "persisted") throw new Error("Committed row did not survive close/restart");
			return { detail: "Committed state survived clean close and read-only restart", evidence: { restartPath } };
		});

		await check("durableCommitRecovery", true, async () => {
			const durablePath = path.join(probeRoot, "durable-crash.db");
			const connect = await loadNativeConnect();
			const setup = await connect(durablePath, { experimental: ["multiprocess_wal"] });
			await setup.exec("PRAGMA synchronous = FULL; CREATE TABLE durable(value TEXT PRIMARY KEY)");
			await setup.close();
			const marker = path.join(probeRoot, "durable-commit.marker");
			const childCode = `import { connect } from "@tursodatabase/database"; const db=await connect(process.argv[1],{experimental:["multiprocess_wal"]}); await db.exec("PRAGMA synchronous = FULL"); const tx=db.transactionAsync(async t=>{await t.run("INSERT INTO durable VALUES ('acknowledged')")}); await tx.immediate(); await Bun.write(process.argv[2],"commit-returned"); process.kill(process.pid,"SIGKILL");`;
			const child = Bun.spawn([process.execPath, "--eval", childCode, durablePath, marker], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			});
			await waitForFile(marker, 5_000);
			const exitCode = await child.exited;
			const recovered = await connect(durablePath, { experimental: ["multiprocess_wal"] });
			const row = await recovered.get<{ value: string }>("SELECT value FROM durable");
			const synchronous = await recovered.get<Record<string, unknown>>("PRAGMA synchronous");
			await recovered.close();
			if (row?.value !== "acknowledged") throw new Error("Commit acknowledged before forced process death was not recovered");
			return {
				detail: "FULL synchronous commit returned before SIGKILL and recovered on a new connection",
				evidence: { childExitCode: exitCode, synchronous: synchronous?.synchronous ?? synchronous?.["0"] },
			};
		});

		await check("nativeBackupApi", false, async () => {
			const connect = await loadNativeConnect();
			const nativePath = path.join(probeRoot, "native-backup-source.db");
			const native = await connect(nativePath);
			try {
				await native.exec("CREATE TABLE backup_probe(value TEXT); INSERT INTO backup_probe VALUES ('native')");
				await native.backup(path.join(probeRoot, "native-backup-target.db"), {});
			} finally {
				await native.close();
			}
			return { detail: "Pinned native backup API completed" };
		});

		await check("closedCheckpointBackup", true, async () => {
			const source = path.join(probeRoot, "backup-source.db");
			const destination = path.join(probeRoot, "backup-copy.db");
			const backupDatabase = await openLocalTursoDatabase({ path: source, allowedRoot: probeRoot });
			await backupDatabase.run("INSERT INTO maintenance_state(name, value, updated_at) VALUES ('backup', 'verified', 1)");
			const receipt = await backupDatabase.closeAndBackup(destination, probeRoot);
			const copy = await openLocalTursoDatabase({
				path: destination,
				allowedRoot: probeRoot,
				readonly: true,
				fileMustExist: true,
			});
			const row = await copy.get<{ value: string }>("SELECT value FROM maintenance_state WHERE name = 'backup'");
			await copy.close();
			if (row?.value !== "verified") throw new Error("Closed checkpoint backup omitted committed data");
			return {
				detail: "Checkpoint, close, exclusive full-file copy, fsync, and reopen fallback passed",
				evidence: { ...receipt },
			};
		});

		const ftsReady = await check("nativeFtsIndex", true, async () => {
			await verifyTursoSearchIndex(database!);
			await insertFtsFixture(database!);
			return { detail: "Pinned schema created Turso Tantivy FTS index and transactionally indexed fixtures" };
		});
		if (ftsReady) {
			await check("ftsPhraseAndFilters", true, async () => {
				const phrase = await searchTursoDocuments(database!, { query: '"full text search"', limit: 10 });
				const filtered = await searchTursoDocuments(database!, { query: "database", role: "assistant", limit: 10 });
				const evidence = { phrase: phrase.hits, filtered: filtered.hits };
				if (phrase.hits.length !== 1 || phrase.hits[0]?.eventHash !== "event-3") {
					throw new CapabilityProbeFailure("Phrase query mismatch", evidence);
				}
				if (filtered.hits.length !== 1 || filtered.hits[0]?.role !== "assistant") {
					throw new CapabilityProbeFailure("SQL role filter mismatch", evidence);
				}
				return { detail: "Native phrase search, highlighting, and relational filters returned expected results", evidence };
			});

			await check("ftsRanking", true, async () => {
				const ranked = await searchTursoDocuments(database!, { query: "database", limit: 10 });
				const evidence = { ranked: ranked.hits };
				if (
					ranked.hits.length !== 2 ||
					ranked.hits.some(hit => !Number.isFinite(hit.score)) ||
					new Set(ranked.hits.map(hit => hit.score)).size < 2
				) {
					throw new CapabilityProbeFailure("Pinned native FTS did not produce differentiating BM25 scores", evidence);
				}
				if (ranked.hits[0]!.score < ranked.hits[1]!.score) {
					throw new CapabilityProbeFailure("Adapter ranking order is not descending", evidence);
				}
				return { detail: "Native BM25 scores differentiate documents and are ordered descending", evidence };
			});

			await check("ftsPrefix", true, async () => {
				const prefix = await searchTursoDocuments(database!, { query: "data*", limit: 10 });
				const evidence = { query: "data*", hits: prefix.hits };
				if (prefix.hits.length !== 2) {
					throw new CapabilityProbeFailure("Pinned native FTS prefix query returned incomplete results", evidence);
				}
				return { detail: "Native Tantivy prefix query matched both database documents", evidence };
			});

			await check("ftsUpdateDelete", true, async () => {
				await upsertTursoSearchDocument(database!, {
					eventHash: "event-2",
					originId: "origin-capability",
					role: "assistant",
					eventTime: 2,
					text: "keyword removed from this document",
				});
				const afterUpdate = await searchTursoDocuments(database!, { query: "database", limit: 10 });
				await deleteTursoSearchDocument(database!, "event-1");
				const afterDelete = await searchTursoDocuments(database!, { query: "database", limit: 10 });
				if (afterUpdate.hits.length !== 1 || afterUpdate.hits[0]?.eventHash !== "event-1" || afterDelete.hits.length !== 0) {
					throw new Error("FTS update/delete maintenance returned stale documents");
				}
				return { detail: "UPDATE removed stale terms and DELETE removed tombstoned hits", evidence: { afterUpdate, afterDelete } };
			});

			await check("ftsTransactionConsistency", true, async () => {
				let visibleInside = false;
				await database!.transactionAsync(async transaction => {
					await upsertTursoSearchDocument(transaction, {
						eventHash: "event-3",
						originId: "origin-capability",
						role: "user",
						eventTime: 3,
						text: "transactional visibility sentinel",
					});
					const rows = await transaction.all<{ event_hash: string }>(
						"SELECT event_hash FROM search_documents WHERE fts_match(text, ?)",
						"sentinel",
					);
					visibleInside = rows.length > 0;
				});
				const afterCommit = await searchTursoDocuments(database!, { query: "sentinel", limit: 10 });
				if (afterCommit.hits.length !== 1 || afterCommit.hits[0]?.eventHash !== "event-3") {
					throw new CapabilityProbeFailure("FTS transaction did not publish the committed update", {
						visibleInside,
						afterCommit: afterCommit.hits,
					});
				}
				return {
					detail: visibleInside
						? "FTS update was visible inside its transaction and remained visible after commit"
						: "FTS update became visible after commit",
					evidence: { visibleInside, afterCommit: afterCommit.hits },
				};
			});

			await check("ftsOptimizeAndBoundedIteration", true, async () => {
				await optimizeTursoSearchIndex(database!);
				for (let index = 0; index < 8; index++) {
					await database!.run(
						`INSERT INTO payloads(payload_id, content_hash, codec, codec_version, uncompressed_length, stored_length, chunk_count, created_at)
						 VALUES (?, ?, 'identity', 1, 8, 8, 0, ?)`,
						`bounded-payload-${index}`,
						`bounded-hash-${index}`,
						10 + index,
					);
					await database!.run(
						`INSERT INTO events(event_hash, origin_id, kind, timestamp, payload_id, canonicalizer_version, canonical_length)
						 VALUES (?, 'origin-capability', 'message', ?, ?, 1, 8)`,
						`bounded-event-${index}`,
						10 + index,
						`bounded-payload-${index}`,
					);
					await upsertTursoSearchDocument(database!, {
						eventHash: `bounded-event-${index}`,
						originId: "origin-capability",
						role: "user",
						eventTime: 10 + index,
						text: `bounded sentinel ${index}`,
					});
				}
				await optimizeTursoSearchIndex(database!);
				const page = await searchTursoDocuments(database!, { query: "bounded", limit: 3 });
				if (page.hits.length !== 3 || page.nextOffset !== 3) throw new Error("FTS query did not enforce its requested bound");
				return { detail: "OPTIMIZE INDEX rebuilt segments and search materialized only limit+1 rows", evidence: { page } };
			});
		} else {
			for (const name of [
				"ftsPhraseAndFilters",
				"ftsRanking",
				"ftsPrefix",
				"ftsUpdateDelete",
				"ftsTransactionConsistency",
				"ftsOptimizeAndBoundedIteration",
			]) {
				capabilities[name] = {
					status: "unknown",
					mandatory: true,
					detail: "Native FTS index prerequisite failed",
					evidence: {},
				};
			}
		}
		await database.close();
	}

	const mandatoryFailures = Object.entries(capabilities)
		.filter(([, result]) => result.mandatory && result.status !== "supported")
		.map(([name]) => name);
	const report: TursoCapabilityReport = {
		reportVersion: 1,
		generatedAt: new Date().toISOString(),
		databaseModeEnabled: mandatoryFailures.length === 0,
		engine: {
			package: "@tursodatabase/database",
			packageVersion: TURSO_DATABASE_PACKAGE_VERSION,
			nativePackage: "@tursodatabase/database-linux-x64-gnu",
			nativePackageVersion: TURSO_NATIVE_PACKAGE_VERSION,
			schemaVersion: TURSO_SCHEMA_VERSION,
		},
		runtime: {
			bunVersion: Bun.version,
			validatedBunVersion: TURSO_VALIDATED_BUN_VERSION,
			platform: process.platform,
			arch: process.arch,
		},
		probeRoot,
		capabilities,
		unsupportedGuarantees: Object.entries(capabilities)
			.filter(([, result]) => result.status === "unsupported")
			.map(([name]) => name),
		unknownGuarantees: Object.entries(capabilities)
			.filter(([, result]) => result.status === "unknown")
			.map(([name]) => name),
		mandatoryFailures,
		nativeLoadApproaches,
		ftsRankingPrefixApproaches,
	};
	if (options.reportPath) await Bun.write(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
	return report;
}
