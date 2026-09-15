import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EngineReceipt, FileSizes, MetricReceipt, ResourceDelta } from "./types";
import { databaseFileSizes, distribution, measureResources, sha256File, sha256Text, streamTextLines } from "./util";

export interface BenchmarkRow {
	id: string;
	originId: string;
	parentId: string | null;
	kind: string;
	text: string;
	payload: Uint8Array;
}

export interface ProducedRows {
	actualRows: number;
	scaledRows: number;
	longestEntries: number;
	forkBranches: number;
	giantOutputBytes: number;
	inputBytes: number;
}

export interface DirectSqliteOptions {
	databasePath: string;
	exportPath: string;
	reimportPath: string;
	iterations: number;
	produceRows: (visit: (row: BenchmarkRow) => void | Promise<void>) => Promise<ProducedRows>;
}
export interface DirectSqliteResult {
	engine: EngineReceipt;
	exportRecovery: {
		status: "measured" | "blocked" | "skipped";
		reason: string;
		exportSha256: string | null;
		reimportDatabaseSha256: string | null;
		rowsExported: number;
		rowsReimported: number;
		semanticHashBefore: string | null;
		semanticHashAfter: string | null;
	};
	fixtures: ProducedRows;
}


const SETTINGS = {
	journal_mode: "wal",
	synchronous: "full",
	foreign_keys: true,
	busy_timeout_ms: 5000,
	cache_kib: 32768,
	wal_autocheckpoint_pages: 1000,
	connections: 1,
	query_page_rows: 100,
	search_rows: 20,
	context_rows: 500,
};

function applySettings(database: Database): void {
	database.exec("PRAGMA journal_mode=WAL");
	database.exec("PRAGMA synchronous=FULL");
	database.exec("PRAGMA foreign_keys=ON");
	database.exec("PRAGMA busy_timeout=5000");
	database.exec("PRAGMA cache_size=-32768");
	database.exec("PRAGMA wal_autocheckpoint=1000");
	database.exec("PRAGMA temp_store=MEMORY");
}

function createSchema(database: Database): void {
	applySettings(database);
	database.exec(`
		CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY,
			origin_id TEXT NOT NULL,
			parent_id TEXT,
			kind TEXT NOT NULL,
			search_text TEXT NOT NULL,
			payload BLOB NOT NULL,
			sequence INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS events_origin_sequence ON events(origin_id, sequence DESC);
		CREATE INDEX IF NOT EXISTS events_parent ON events(parent_id);
		CREATE VIRTUAL TABLE IF NOT EXISTS event_search USING fts5(id UNINDEXED, origin_id UNINDEXED, search_text, tokenize='unicode61');
		CREATE TABLE IF NOT EXISTS branches (
			branch_id TEXT PRIMARY KEY,
			origin_id TEXT NOT NULL,
			head_id TEXT,
			generation INTEGER NOT NULL
		);
	`);
}

function openDatabase(databasePath: string): Database {
	const database = new Database(databasePath, { create: true, strict: true });
	createSchema(database);
	return database;
}
function observedSettings(database: Database): Record<string, string | number | boolean | null> {
	const journal = database.query("PRAGMA journal_mode").get() as { journal_mode: string };
	const synchronous = database.query("PRAGMA synchronous").get() as { synchronous: number };
	const foreignKeys = database.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
	const busyTimeout = database.query("PRAGMA busy_timeout").get() as { timeout: number };
	const cacheSize = database.query("PRAGMA cache_size").get() as { cache_size: number };
	const walAutocheckpoint = database.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number };
	return {
		journal_mode: journal.journal_mode,
		synchronous: synchronous.synchronous,
		foreign_keys: foreignKeys.foreign_keys,
		busy_timeout_ms: busyTimeout.timeout,
		cache_size: cacheSize.cache_size,
		wal_autocheckpoint_pages: walAutocheckpoint.wal_autocheckpoint,
		connection_count: 1,
	};
}


async function insertRows(database: Database, produceRows: DirectSqliteOptions["produceRows"]): Promise<{ inserted: number; bytes: number; produced: ProducedRows }> {
	const insertEvent = database.prepare(
		"INSERT OR IGNORE INTO events(id, origin_id, parent_id, kind, search_text, payload, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertSearch = database.prepare("INSERT INTO event_search(id, origin_id, search_text) VALUES (?, ?, ?)");
	const insertBranch = database.prepare(
		"INSERT INTO branches(branch_id, origin_id, head_id, generation) VALUES (?, ?, ?, 1) ON CONFLICT(branch_id) DO UPDATE SET head_id=excluded.head_id, generation=branches.generation+1",
	);
	let inserted = 0;
	let bytes = 0;
	let sequence = 0;
	const transaction = database.transaction((batch: BenchmarkRow[]) => {
		for (const row of batch) {
			sequence++;
			const result = insertEvent.run(row.id, row.originId, row.parentId, row.kind, row.text, row.payload, sequence, Date.now());
			if (result.changes === 0) continue;
			insertSearch.run(row.id, row.originId, row.text);
			insertBranch.run(`branch:${row.originId}`, row.originId, row.id);
			inserted++;
			bytes += row.payload.byteLength;
		}
	});
	const batch: BenchmarkRow[] = [];
	let batchBytes = 0;
	const produced = await produceRows(row => {
		batch.push(row);
		batchBytes += row.payload.byteLength;
		if (batch.length >= 256 || batchBytes >= 8 * 1024 * 1024) {
			transaction(batch.splice(0));
			batchBytes = 0;
		}
	});
	if (batch.length > 0) transaction(batch);
	return { inserted, bytes, produced };
}

function fileStats(database: Database, databasePath: string): Promise<FileSizes> {
	const pageSize = Number((database.query("PRAGMA page_size").get() as { page_size: number }).page_size);
	const pageCount = Number((database.query("PRAGMA page_count").get() as { page_count: number }).page_count);
	const freePages = Number((database.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
	let indexBytes: number | null = null;
	try {
		const row = database
			.query("SELECT coalesce(sum(pgsize), 0) AS bytes FROM dbstat WHERE name IN ('event_search', 'events_origin_sequence', 'events_parent')")
			.get() as { bytes: number };
		indexBytes = Number(row.bytes);
	} catch {
		// dbstat is optional in SQLite builds; receipt records null rather than guessing.
	}
	return databaseFileSizes(databasePath, pageSize, pageCount, freePages, indexBytes);
}

async function repeatedMetric(iterations: number, operation: () => unknown | Promise<unknown>): Promise<MetricReceipt> {
	const times: number[] = [];
	const resources: ResourceDelta[] = [];
	for (let index = 0; index < iterations; index++) {
		const measured = await measureResources(operation);
		times.push(measured.elapsedMs);
		resources.push(measured.resources);
	}
	const first = resources[0];
	const last = resources[resources.length - 1];
	const aggregate =
		first && last
			? {
					cpuUserMicros: resources.reduce((sum, resource) => sum + resource.cpuUserMicros, 0),
					cpuSystemMicros: resources.reduce((sum, resource) => sum + resource.cpuSystemMicros, 0),
					maxRssBytes: Math.max(...resources.map(resource => resource.maxRssBytes)),
					peakPssBytes: resources.some(resource => resource.peakPssBytes !== null)
						? Math.max(...resources.map(resource => resource.peakPssBytes ?? 0))
						: null,
					before: first.before,
					after: last.after,
				}
			: undefined;
	return { status: "measured", latency: distribution(times), resources: aggregate, bridgeCalls: 0, operationCalls: iterations };
}

function listQuery(database: Database): unknown[] {
	return database
		.query("SELECT origin_id, max(created_at) AS updated_at, count(*) AS entries FROM events GROUP BY origin_id ORDER BY updated_at DESC, origin_id LIMIT 100")
		.all();
}

function searchQuery(database: Database): unknown[] {
	return database
		.query("SELECT id, origin_id, snippet(event_search, 2, '[', ']', '…', 24) AS snippet FROM event_search WHERE event_search MATCH ? LIMIT 20")
		.all("benchmark");
}

function contextQuery(database: Database): unknown[] {
	const origin = database.query("SELECT origin_id FROM events GROUP BY origin_id ORDER BY count(*) DESC LIMIT 1").get() as { origin_id: string } | null;
	if (!origin) return [];
	return database
		.query("SELECT id, parent_id, kind, payload FROM events WHERE origin_id = ? ORDER BY sequence DESC LIMIT 500")
		.all(origin.origin_id);
}

async function coldMetric(databasePath: string, iterations: number, query: (database: Database) => unknown): Promise<MetricReceipt> {
	return repeatedMetric(iterations, () => {
		const database = openDatabase(databasePath);
		try {
			return query(database);
		} finally {
			database.close();
		}
	});
}

function appendRow(database: Database, ordinal: number): number {
	const branch = database.query("SELECT branch_id, origin_id, head_id, generation FROM branches ORDER BY branch_id LIMIT 1").get() as
		| { branch_id: string; origin_id: string; head_id: string | null; generation: number }
		| null;
	const originId = branch?.origin_id ?? "benchmark:append";
	const parentId = branch?.head_id ?? null;
	const id = sha256Text(`${originId}\0${parentId ?? ""}\0${ordinal}\0${Bun.nanoseconds()}`);
	const payload = new TextEncoder().encode(JSON.stringify({ type: "message", role: "user", content: `benchmark append ${ordinal}` }));
	const insert = database.transaction(() => {
		const sequence = Number((database.query("SELECT coalesce(max(sequence), 0) + 1 AS value FROM events").get() as { value: number }).value);
		database
			.query("INSERT INTO events(id, origin_id, parent_id, kind, search_text, payload, sequence, created_at) VALUES (?, ?, ?, 'message', ?, ?, ?, ?)")
			.run(id, originId, parentId, `benchmark append ${ordinal}`, payload, sequence, Date.now());
		database.query("INSERT INTO event_search(id, origin_id, search_text) VALUES (?, ?, ?)").run(id, originId, `benchmark append ${ordinal}`);
		if (branch) {
			const update = database.query("UPDATE branches SET head_id = ?, generation = generation + 1 WHERE branch_id = ? AND head_id IS ?").run(id, branch.branch_id, parentId);
			if (update.changes !== 1) throw new Error("expected-head append lost compare-and-swap");
		} else {
			database.query("INSERT INTO branches(branch_id, origin_id, head_id, generation) VALUES (?, ?, ?, 1)").run(`branch:${originId}`, originId, id);
		}
	});
	insert();
	return payload.byteLength;
}

function hashSemanticRows(database: Database): string {
	const hasher = new Bun.CryptoHasher("sha256");
	const query = database.query("SELECT id, origin_id, parent_id, kind, search_text, hex(payload) AS payload_hex, sequence FROM events ORDER BY sequence");
	for (const row of query.iterate() as Iterable<Record<string, unknown>>) hasher.update(`${JSON.stringify(row)}\n`);
	return hasher.digest("hex");
}

async function exportDatabase(database: Database, exportPath: string): Promise<{ rows: number; bytes: number; semanticHash: string }> {
	await Bun.write(exportPath, "");
	const output = await fs.open(exportPath, "a");
	const hasher = new Bun.CryptoHasher("sha256");
	let rows = 0;
	let bytes = 0;
	try {
		const query = database.query("SELECT id, origin_id, parent_id, kind, search_text, hex(payload) AS payload_hex, sequence FROM events ORDER BY sequence");
		for (const row of query.iterate() as Iterable<Record<string, unknown>>) {
			const line = `${JSON.stringify(row)}\n`;
			await output.write(line);
			hasher.update(line);
			rows++;
			bytes += Buffer.byteLength(line);
		}
		await output.sync();
	} finally {
		await output.close();
	}
	return { rows, bytes, semanticHash: hasher.digest("hex") };
}

async function reimportExport(exportPath: string, reimportPath: string): Promise<{ rows: number; semanticHash: string }> {
	await fs.rm(reimportPath, { force: true });
	await fs.rm(`${reimportPath}-wal`, { force: true });
	await fs.rm(`${reimportPath}-shm`, { force: true });
	const database = openDatabase(reimportPath);
	let rows = 0;
	let semanticHash = "";
	try {
		const insertEvent = database.prepare(
			"INSERT INTO events(id, origin_id, parent_id, kind, search_text, payload, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
		);
		const insertSearch = database.prepare("INSERT INTO event_search(id, origin_id, search_text) VALUES (?, ?, ?)");
		const transaction = database.transaction((batch: Record<string, unknown>[]) => {
			for (const row of batch) {
				const payload = Uint8Array.fromHex(String(row.payload_hex));
				insertEvent.run(row.id, row.origin_id, row.parent_id, row.kind, row.search_text, payload, row.sequence);
				insertSearch.run(row.id, row.origin_id, row.search_text);
				rows++;
			}
		});
		const batch: Record<string, unknown>[] = [];
		await streamTextLines(exportPath, text => {
			if (!text) return;
			batch.push(JSON.parse(text) as Record<string, unknown>);
			if (batch.length >= 256) transaction(batch.splice(0));
		});
		if (batch.length > 0) transaction(batch);
		database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		semanticHash = hashSemanticRows(database);
	} finally {
		database.close();
	}
	return { rows, semanticHash };
}

export async function runDirectSqlite(options: DirectSqliteOptions): Promise<DirectSqliteResult> {
	await fs.mkdir(path.dirname(options.databasePath), { recursive: true });
	for (const suffix of ["", "-wal", "-shm"]) await fs.rm(`${options.databasePath}${suffix}`, { force: true });
	const database = openDatabase(options.databasePath);
	const sqliteVersionRow = database.query("SELECT sqlite_version() AS version").get() as { version: string };
	const engineVersion = `SQLite ${sqliteVersionRow.version} via Bun ${Bun.version}`;
	const metrics: Record<string, MetricReceipt> = {};
	const appliedSettings = observedSettings(database);
	let exportReceipt = {
		status: "blocked" as const,
		reason: "export/reimport did not run",
		exportSha256: null as string | null,
		reimportDatabaseSha256: null as string | null,
		rowsExported: 0,
		rowsReimported: 0,
		semanticHashBefore: null as string | null,
		semanticHashAfter: null as string | null,
	};
	let fixtures: ProducedRows = {
		actualRows: 0,
		scaledRows: 0,
		longestEntries: 0,
		forkBranches: 0,
		giantOutputBytes: 0,
		inputBytes: 0,
	};
	try {
		const diskBefore = await fileStats(database, options.databasePath);
		const imported = await measureResources(() => insertRows(database, options.produceRows));
		fixtures = imported.value.produced;
		const diskAfter = await fileStats(database, options.databasePath);
		metrics.import = {
			status: "measured",
			latency: distribution([imported.elapsedMs]),
			resources: imported.resources,
			bridgeCalls: 0,
			operationCalls: imported.value.inserted * 3,
			rows: imported.value.inserted,
			bytes: imported.value.bytes,
			throughputRowsPerSecond: imported.elapsedMs === 0 ? 0 : (imported.value.inserted * 1000) / imported.elapsedMs,
			throughputBytesPerSecond: imported.elapsedMs === 0 ? 0 : (imported.value.bytes * 1000) / imported.elapsedMs,
			diskBefore,
			diskAfter,
		};
		metrics.import.details = { appliedConnectionSettings: appliedSettings, batchByteCap: 8 * 1024 * 1024, batchRowCap: 256 };

		metrics["list.cold"] = await coldMetric(options.databasePath, options.iterations, listQuery);
		metrics["search.cold"] = await coldMetric(options.databasePath, options.iterations, searchQuery);
		metrics["context.cold"] = await coldMetric(options.databasePath, options.iterations, contextQuery);
		metrics["append.cold"] = await repeatedMetric(options.iterations, () => {
			const connection = openDatabase(options.databasePath);
			try {
				return appendRow(connection, Math.random());
			} finally {
				connection.close();
			}
		});
		metrics["list.warm"] = await repeatedMetric(options.iterations, () => listQuery(database));
		metrics["search.warm"] = await repeatedMetric(options.iterations, () => searchQuery(database));
		metrics["context.warm"] = await repeatedMetric(options.iterations, () => contextQuery(database));
		metrics["append.warm"] = await repeatedMetric(options.iterations, () => appendRow(database, Math.random()));
		for (const name of ["list", "search", "context", "append"]) {
			metrics[`${name}.cold`].details = {
				cacheState: "new SQLite connection and empty per-connection page cache; Linux OS page cache was not globally dropped",
				osCacheDropped: false,
			};
			metrics[`${name}.warm`].details = { cacheState: "reused SQLite connection and page cache", osCacheDropped: false };
		}
		const exported = await measureResources(() => exportDatabase(database, options.exportPath));
		metrics.export = {
			status: "measured",
			latency: distribution([exported.elapsedMs]),
			resources: exported.resources,
			bridgeCalls: 0,
			operationCalls: exported.value.rows,
			rows: exported.value.rows,
			bytes: exported.value.bytes,
			throughputRowsPerSecond: exported.elapsedMs === 0 ? 0 : (exported.value.rows * 1000) / exported.elapsedMs,
			throughputBytesPerSecond: exported.elapsedMs === 0 ? 0 : (exported.value.bytes * 1000) / exported.elapsedMs,
		};
		database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		database.close();
		const reimported = await reimportExport(options.exportPath, options.reimportPath);
		const exportSha256 = await sha256File(options.exportPath);
		const reimportDatabaseSha256 = await sha256File(options.reimportPath);
		exportReceipt = {
			status: exported.value.rows === reimported.rows && exported.value.semanticHash === reimported.semanticHash ? "measured" : "blocked",
			reason:
				exported.value.rows === reimported.rows && exported.value.semanticHash === reimported.semanticHash
					? "direct SQLite baseline export was fsynced, reimported, and semantic stream hashes matched"
					: "export/reimport row count or semantic hash mismatch",
			exportSha256,
			reimportDatabaseSha256,
			rowsExported: exported.value.rows,
			rowsReimported: reimported.rows,
			semanticHashBefore: exported.value.semanticHash,
			semanticHashAfter: reimported.semanticHash,
		};
		metrics.export.details = {
			exportSha256,
			reimportDatabaseSha256,
			rowsExported: exported.value.rows,
			rowsReimported: reimported.rows,
			semanticHashBefore: exported.value.semanticHash,
			semanticHashAfter: reimported.semanticHash,
			hashSource: "canonical event rows queried independently from source and reimport databases",
		};
	} finally {
		try {
			database.close();
		} catch {
			// The successful path closes before reimport so the checkpoint is durable.
		}
	}
	return {
		engine: {
			status: "measured",
			engine: "direct-sqlite",
			version: engineVersion,
			settings: SETTINGS,
			metrics,
			bridgeCallTotal: Object.values(metrics).reduce((sum, metric) => sum + (metric.bridgeCalls ?? 0), 0),
		},
		exportRecovery: exportReceipt,
		fixtures,
	};
}

export { SETTINGS as DIRECT_SQLITE_SETTINGS };
