import * as fs from "node:fs/promises";
import * as path from "node:path";

import { CANONICALIZER_VERSION } from "../../../packages/coding-agent/src/storage/identity";
import {
	WCDB_ENGINE_PIN,
	WCDB_LOGICAL_SCHEMA_VERSION,
	WCDB_MAX_READER_SCHEMA_VERSION,
	WCDB_MIN_READER_SCHEMA_VERSION,
	WCDB_SCHEMA_BOOTSTRAP_STATEMENTS,
	WCDB_SCHEMA_CONNECTION_STATEMENTS,
	WCDB_SCHEMA_INVARIANT_AUDITS,
	WCDB_SCHEMA_MIGRATIONS,
} from "../../../packages/coding-agent/src/storage/schema";
import {
	loadWcdbNative,
	probeWcdbNativeCapability,
	type WcdbNativeHandle,
	type WcdbValue,
} from "../../../packages/coding-agent/src/storage/wcdb/native";

const TEAM_BOOTSTRAP_ROOT = "/home/andual/Projects/.omp-wcdb-team/staging/native/bootstrap/";
const TEAM_RECEIPT_ROOT = "/home/andual/Projects/.omp-wcdb-team/artifacts/native/";
const PRODUCTION_DISABLED_REASON =
	"DB production capability remains disabled because synchronous Bun FFI blocks the worker event loop and cannot provide active cancellation isolation.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function scalar(handle: WcdbNativeHandle, sql: string, parameters: readonly WcdbValue[] = []): WcdbValue {
	const result = handle.executeBatch({
		transactional: false,
		statements: [{ kind: "query", sql, parameters, maxRows: 1 }],
	});
	const value = result.statements[0]?.rows[0]?.[0];
	if (value === undefined) throw new Error(`Query returned no scalar: ${sql}`);
	return value;
}

async function sha256(filePath: string): Promise<string> {
	return Bun.CryptoHasher.hash("sha256", await Bun.file(filePath).arrayBuffer(), "hex");
}

const REQUIRED_SCHEMA_OBJECTS = [
	"branches",
	"branch_mappings",
	"checkpoints",
	"compression_dictionaries",
	"events",
	"export_jobs",
	"export_manifests",
	"import_items",
	"import_jobs",
	"maintenance_state",
	"metadata_observations",
	"metadata_revisions",
	"origins",
	"payload_chunks",
	"payloads",
	"replica_receipts",
	"schema_migrations",
	"search_documents",
	"search_fts",
	"source_aliases",
	"source_manifests",
	"storage_meta",
	"versions",
] as const;

async function main(): Promise<void> {
	const [libraryArgument, runRootArgument, receiptArgument] = process.argv.slice(2);
	if (!libraryArgument || !runRootArgument || !receiptArgument) {
		throw new Error("Usage: bun bootstrap-smoke.ts <bridge-library> <new-team-run-dir> <team-receipt-path>");
	}

	const libraryPath = path.resolve(libraryArgument);
	const runRoot = path.resolve(runRootArgument);
	const receiptPath = path.resolve(receiptArgument);
	assert(`${runRoot}${path.sep}`.startsWith(TEAM_BOOTSTRAP_ROOT), `Refusing smoke DB outside ${TEAM_BOOTSTRAP_ROOT}`);
	assert(receiptPath.startsWith(TEAM_RECEIPT_ROOT), `Refusing receipt outside ${TEAM_RECEIPT_ROOT}`);
	await fs.mkdir(path.dirname(runRoot), { recursive: true });
	await fs.mkdir(runRoot, { recursive: false });

	const startedAt = new Date().toISOString();
	const databasePath = path.join(runRoot, "sessions.wcdb.sqlite");
	const lockPath = path.resolve(import.meta.dir, "../wcdb.lock.json");
	const lock = (await Bun.file(lockPath).json()) as {
		wcdb: { release: string; commit: string; archiveSha256: string };
		bundled: { sqliteVersion: string; sqliteSourceId: string };
		outputs: { bridgeSha256: string };
	};
	const librarySha256 = await sha256(libraryPath);
	const lockSha256 = await sha256(lockPath);
	assert(librarySha256 === lock.outputs.bridgeSha256, "Bridge hash does not match wcdb.lock.json");
	assert(lock.wcdb.release === WCDB_ENGINE_PIN.wcdbVersion, "Schema pin and native lock WCDB versions differ");
	assert(lock.wcdb.commit === WCDB_ENGINE_PIN.wcdbCommit, "Schema pin and native lock WCDB commits differ");
	assert(lock.bundled.sqliteVersion === WCDB_ENGINE_PIN.bundledSqliteVersion, "Schema pin and native lock SQLite versions differ");
	assert(lock.bundled.sqliteSourceId === WCDB_ENGINE_PIN.bundledSqliteSourceId, "Schema pin and native lock SQLite source IDs differ");

	const capability = probeWcdbNativeCapability({ libraryPath });
	assert(capability.enabled, capability.reason ?? "Pinned WCDB bridge did not load");
	let handle: WcdbNativeHandle | undefined;
	let verification: Record<string, unknown>;
	try {
		handle = loadWcdbNative({ libraryPath, databasePath, create: true });
		handle.executeBatch({
			transactional: false,
			statements: WCDB_SCHEMA_CONNECTION_STATEMENTS.map(sql => ({ kind: "execute" as const, sql })),
		});

		const now = new Date().toISOString();
		const replicaId = "team-native-bootstrap-smoke";
		handle.executeBatch({
			transactional: true,
			statements: [
				...WCDB_SCHEMA_BOOTSTRAP_STATEMENTS.map(sql => ({ kind: "execute" as const, sql })),
				{
					kind: "execute" as const,
					sql: "INSERT INTO storage_meta (singleton, schema_version, minimum_reader_version, maximum_reader_version, canonicalizer_version, replica_id, wcdb_version, sqlite_version, created_at, updated_at, configuration_generation) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
					parameters: [
						BigInt(WCDB_LOGICAL_SCHEMA_VERSION),
						BigInt(WCDB_MIN_READER_SCHEMA_VERSION),
						BigInt(WCDB_MAX_READER_SCHEMA_VERSION),
						BigInt(CANONICALIZER_VERSION),
						replicaId,
						WCDB_ENGINE_PIN.wcdbVersion,
						WCDB_ENGINE_PIN.bundledSqliteVersion,
						now,
						now,
					],
				},
				...WCDB_SCHEMA_MIGRATIONS.map(migration => ({
					kind: "execute" as const,
					sql: "INSERT INTO schema_migrations (version, name, checksum, rollback_snapshot_hash, applied_at) VALUES (?, ?, ?, NULL, ?)",
					parameters: [BigInt(migration.version), migration.name, migration.checksum, now],
				})),
			],
		});

		const engine = handle.executeBatch({
			transactional: false,
			statements: [
				{ kind: "query", sql: "SELECT sqlite_version(), sqlite_source_id()", maxRows: 1 },
				{
					kind: "query",
					sql: "SELECT schema_version, minimum_reader_version, maximum_reader_version, canonicalizer_version, replica_id, wcdb_version, sqlite_version, configuration_generation FROM storage_meta WHERE singleton = 1",
					maxRows: 1,
				},
				{ kind: "query", sql: "SELECT version, name, checksum FROM schema_migrations ORDER BY version", maxRows: 100 },
				{ kind: "query", sql: "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name", maxRows: 500 },
			],
		});
		const engineRow = engine.statements[0]?.rows[0];
		const headerRow = engine.statements[1]?.rows[0];
		const migrationRows = engine.statements[2]?.rows ?? [];
		const objectNames = new Set((engine.statements[3]?.rows ?? []).map(row => String(row[0])));
		const missingObjects = REQUIRED_SCHEMA_OBJECTS.filter(name => !objectNames.has(name));
		const audits = WCDB_SCHEMA_INVARIANT_AUDITS.map(audit => {
			const result = handle!.executeBatch({
				transactional: false,
				statements: [{ kind: "query", sql: audit.sql, maxRows: 1 }],
			});
			return { name: audit.name, rows: result.statements[0]?.rows.length ?? 0 };
		});
		const foreignKeys = scalar(handle, "PRAGMA foreign_keys");

		assert(engineRow?.[0] === WCDB_ENGINE_PIN.bundledSqliteVersion, "Real bridge SQLite version differs from schema pin");
		assert(engineRow?.[1] === WCDB_ENGINE_PIN.bundledSqliteSourceId, "Real bridge SQLite source ID differs from schema pin");
		assert(headerRow?.[0] === BigInt(WCDB_LOGICAL_SCHEMA_VERSION), "Stored logical schema version mismatch");
		assert(headerRow?.[1] === BigInt(WCDB_MIN_READER_SCHEMA_VERSION), "Stored minimum reader version mismatch");
		assert(headerRow?.[2] === BigInt(WCDB_MAX_READER_SCHEMA_VERSION), "Stored maximum reader version mismatch");
		assert(headerRow?.[3] === BigInt(CANONICALIZER_VERSION), "Stored canonicalizer version mismatch");
		assert(headerRow?.[4] === replicaId, "Stored replica ID mismatch");
		assert(headerRow?.[5] === WCDB_ENGINE_PIN.wcdbVersion, "Stored WCDB version mismatch");
		assert(headerRow?.[6] === WCDB_ENGINE_PIN.bundledSqliteVersion, "Stored SQLite version mismatch");
		assert(headerRow?.[7] === 0n, "New database configuration generation must be zero");
		assert(foreignKeys === 1n, "Foreign-key enforcement is not enabled on the bootstrap connection");
		assert(migrationRows.length === WCDB_SCHEMA_MIGRATIONS.length, "Stored schema migration count mismatch");
		assert(missingObjects.length === 0, `Missing schema objects: ${missingObjects.join(", ")}`);
		assert(audits.every(audit => audit.rows === 0), "One or more schema invariant audits returned rows");

		handle.checkpoint("truncate");
		verification = {
			passed: true,
			foreignKeys: String(foreignKeys),
			sqliteVersion: engineRow[0],
			sqliteSourceId: engineRow[1],
			storageMeta: headerRow,
			migrations: migrationRows,
			missingSchemaObjects: missingObjects,
			invariantAudits: audits,
			connectionStatementCount: WCDB_SCHEMA_CONNECTION_STATEMENTS.length,
			transactionalStatementCount: WCDB_SCHEMA_BOOTSTRAP_STATEMENTS.length + 1 + WCDB_SCHEMA_MIGRATIONS.length,
			requiredSchemaObjects: REQUIRED_SCHEMA_OBJECTS,
		};
	} finally {
		handle?.close();
	}

	const databaseStat = await fs.stat(databasePath);
	const receipt = {
		schemaVersion: 1,
		startedAt,
		completedAt: new Date().toISOString(),
		command: `bun native/wcdb/scripts/bootstrap-smoke.ts ${libraryPath} ${runRoot} ${receiptPath}`,
		ownership: {
			teamRoot: "/home/andual/Projects/.omp-wcdb-team",
			databasePath,
			productionMutation: false,
			sharedCorpusMutation: false,
			jsonlInvolved: false,
		},
		pin: {
			lockPath,
			lockSha256,
			wcdbVersion: lock.wcdb.release,
			wcdbCommit: lock.wcdb.commit,
			sourceArchiveSha256: lock.wcdb.archiveSha256,
			sqliteVersion: lock.bundled.sqliteVersion,
			sqliteSourceId: lock.bundled.sqliteSourceId,
			libraryPath,
			librarySha256,
			buildId: capability.buildId,
		},
		framing: {
			connectionStatements: WCDB_SCHEMA_CONNECTION_STATEMENTS.length,
			transactionalSchemaStatements: WCDB_SCHEMA_BOOTSTRAP_STATEMENTS.length,
			migrationChecksums: WCDB_SCHEMA_MIGRATIONS.map(migration => ({ version: migration.version, checksum: migration.checksum })),
		},
		verification,
		database: {
			bytes: databaseStat.size,
			sha256: await sha256(databasePath),
		},
		capability: {
			nativeBootstrapPassed: true,
			productionModeEnabled: false,
			reason: PRODUCTION_DISABLED_REASON,
		},
	};
	await Bun.write(receiptPath, `${JSON.stringify(receipt, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, databasePath, productionModeEnabled: false, reason: PRODUCTION_DISABLED_REASON })}\n`);
}

await main();
