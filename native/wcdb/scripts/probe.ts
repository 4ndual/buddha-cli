import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
	loadWcdbNative,
	probeWcdbNativeCapability,
	WcdbNativeError,
	type WcdbNativeHandle,
	type WcdbValue,
} from "../../../packages/coding-agent/src/storage/wcdb/native/index";

interface ProbeFixture {
	documents: { id: number; body: string }[];
	payload: string;
	binary: number[];
	int64: string;
}

interface Gate {
	status: "pass" | "fail" | "unsupported";
	measured: true;
	detail: string;
	evidence?: unknown;
}

interface ProbeProcess {
	stdout: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number): void;
}

const args = process.argv.slice(2);
const childMode = args[0];

function scalar(handle: WcdbNativeHandle, sql: string, parameters: readonly WcdbValue[] = []): WcdbValue {
	const result = handle.executeBatch({
		transactional: false,
		statements: [{ kind: "query", sql, parameters, maxRows: 1 }],
	});
	const value = result.statements[0]?.rows[0]?.[0];
	if (value === undefined) throw new Error(`Query returned no scalar: ${sql}`);
	return value;
}

async function child(libraryPath: string, databasePath: string, mode: "crash" | "lock"): Promise<never> {
	const handle = loadWcdbNative({ libraryPath, databasePath, create: false });
	if (mode === "crash") {
		handle.executeBatch({
			transactional: false,
			statements: [
				{ kind: "query", sql: "PRAGMA journal_mode=WAL", maxRows: 1 },
				{ kind: "execute", sql: "PRAGMA synchronous=FULL" },
			],
		});
	}
	if (mode === "crash") {
		if (scalar(handle, "PRAGMA journal_mode") !== "wal" || scalar(handle, "PRAGMA synchronous") !== 2n) {
			throw new Error("Crash child durability pragmas did not apply");
		}
		handle.executeBatch({
			transactional: true,
			statements: [{ kind: "execute", sql: "INSERT INTO durability(note) VALUES(?)", parameters: ["acknowledged-before-crash"] }],
		});
		process.stdout.write("ACK\n");
	} else {
		handle.executeBatch({ transactional: false, statements: [{ kind: "execute", sql: "BEGIN IMMEDIATE" }] });
		process.stdout.write("LOCKED\n");
	}
	await Bun.sleep(10_000);
	throw new Error("Probe child was not terminated as expected");
}

async function waitForMarker(processHandle: ProbeProcess, marker: string): Promise<void> {
	const reader = processHandle.stdout.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	while (!seen.includes(marker)) {
		const result = await reader.read();
		if (result.done) throw new Error(`Probe child exited before ${marker}`);
		seen += decoder.decode(result.value, { stream: true });
	}
	reader.releaseLock();
}

async function spawnChild(mode: "crash" | "lock", libraryPath: string, databasePath: string): Promise<ProbeProcess> {
	const processHandle = Bun.spawn([process.execPath, import.meta.path, `--child-${mode}`, libraryPath, databasePath], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	await waitForMarker(processHandle, mode === "crash" ? "ACK\n" : "LOCKED\n");
	return processHandle;
}

function record(gates: Record<string, Gate>, name: string, passed: boolean, detail: string, evidence?: unknown): void {
	gates[name] = { status: passed ? "pass" : "fail", measured: true, detail, evidence };
}

async function main(): Promise<void> {
	const libraryPath = args[0];
	const runRoot = args[1];
	const receiptPath = args[2];
	if (!libraryPath || !runRoot || !receiptPath) {
		throw new Error("Usage: bun probe.ts <library> <team-staging-run-dir> <receipt-path>");
	}
	const requiredRoot = "/home/andual/Projects/.omp-wcdb-team/staging/native/probes/";
	if (!path.resolve(runRoot).startsWith(requiredRoot)) throw new Error(`Refusing probe outside ${requiredRoot}`);
	await fs.mkdir(runRoot, { recursive: false });
	const fixtureSource = path.join(import.meta.dir, "../fixtures/probe-corpus.json");
	const fixtureCopy = path.join(runRoot, "probe-corpus.json");
	await Bun.write(fixtureCopy, Bun.file(fixtureSource));
	const fixture = (await Bun.file(fixtureCopy).json()) as ProbeFixture;
	const databasePath = path.join(runRoot, "sessions.wcdb.sqlite");
	const backupPath = path.join(runRoot, "sessions.backup.sqlite");
	const gates: Record<string, Gate> = {};
	const startedAt = new Date().toISOString();

	const loadCapability = probeWcdbNativeCapability({ libraryPath });
	record(gates, "ffiLoad", loadCapability.enabled, loadCapability.reason ?? "Bun FFI loaded ABI v1", loadCapability);
	let handle = loadWcdbNative({ libraryPath, databasePath });

	const pragmas = handle.executeBatch({
		transactional: false,
		statements: [
			{ kind: "query", sql: "PRAGMA journal_mode=WAL", maxRows: 1 },
			{ kind: "execute", sql: "PRAGMA synchronous=FULL" },
			{ kind: "execute", sql: "PRAGMA foreign_keys=ON" },
			{ kind: "query", sql: "PRAGMA busy_timeout=2500", maxRows: 1 },
			{ kind: "query", sql: "PRAGMA journal_mode", maxRows: 1 },
			{ kind: "query", sql: "PRAGMA synchronous", maxRows: 1 },
			{ kind: "query", sql: "PRAGMA foreign_keys", maxRows: 1 },
			{ kind: "query", sql: "PRAGMA busy_timeout", maxRows: 1 },
		],
	});
	const pragmaValues = pragmas.statements.map((statement) => statement.rows[0]?.[0] ?? null);
	record(gates, "wal", pragmaValues[4] === "wal", "journal_mode must read back as WAL", pragmaValues);
	record(gates, "synchronousFull", pragmaValues[5] === 2n, "synchronous must read back as FULL (2)", pragmaValues);
	record(gates, "foreignKeysEnabled", pragmaValues[6] === 1n, "foreign_keys must read back enabled", pragmaValues);
	record(gates, "busyTimeoutConfigured", pragmaValues[7] === 2500n, "busy_timeout must read back as 2500 ms", pragmaValues);

	handle.executeBatch({
		transactional: true,
		statements: [
			{ kind: "execute", sql: "CREATE TABLE parent(id INTEGER PRIMARY KEY)" },
			{ kind: "execute", sql: "CREATE TABLE child(parent_id INTEGER REFERENCES parent(id))" },
			{ kind: "execute", sql: "CREATE TABLE values_probe(i INTEGER, text_value TEXT, bytes BLOB)" },
			{ kind: "execute", sql: "CREATE TABLE durability(id INTEGER PRIMARY KEY, note TEXT NOT NULL)" },
			{
				kind: "execute",
				sql: "CREATE TABLE payloads(id INTEGER PRIMARY KEY, codec TEXT NOT NULL, original_length INTEGER NOT NULL, body BLOB NOT NULL, search_text TEXT NOT NULL)",
			},
		],
	});
	let foreignKeyRejected = false;
	try {
		handle.executeBatch({
			transactional: true,
			statements: [{ kind: "execute", sql: "INSERT INTO child(parent_id) VALUES(404)" }],
		});
	} catch (error) {
		foreignKeyRejected = error instanceof WcdbNativeError && error.status === 6;
	}
	record(gates, "foreignKeyEnforced", foreignKeyRejected && scalar(handle, "SELECT count(*) FROM child") === 0n, "invalid foreign key must reject and roll back");

	const expectedInteger = BigInt(fixture.int64);
	const expectedBinary = new Uint8Array(fixture.binary);
	handle.executeBatch({
		transactional: true,
		statements: [
			{ kind: "execute", sql: "INSERT INTO values_probe VALUES(?, ?, ?)", parameters: [expectedInteger, "acción niño", expectedBinary] },
		],
	});
	const valueRoundTrip = handle.executeBatch({
		transactional: false,
		statements: [{ kind: "query", sql: "SELECT i, text_value, bytes FROM values_probe", maxRows: 1 }],
	}).statements[0]?.rows[0];
	const actualBinary = valueRoundTrip?.[2];
	record(
		gates,
		"int64BinaryUtf8",
		valueRoundTrip?.[0] === expectedInteger
			&& valueRoundTrip[1] === "acción niño"
			&& actualBinary instanceof Uint8Array
			&& actualBinary.byteLength === expectedBinary.byteLength
			&& actualBinary.every((value, index) => value === expectedBinary[index]),
		"int64, UTF-8 text, and arbitrary bytes must round-trip exactly",
		valueRoundTrip,
	);

	handle.executeBatch({
		transactional: true,
		statements: [
			{ kind: "execute", sql: "CREATE VIRTUAL TABLE search_probe USING fts5(body, tokenize='unicode61')" },
			...fixture.documents.map((document) => ({
				kind: "execute" as const,
				sql: "INSERT INTO search_probe(rowid, body) VALUES(?, ?)",
				parameters: [BigInt(document.id), document.body],
			})),
			{ kind: "execute", sql: "CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT NOT NULL)" },
			{ kind: "execute", sql: "CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='docs', content_rowid='id')" },
			{ kind: "execute", sql: "INSERT INTO docs(id, body) VALUES(1, 'code_identifier/path acción exact phrase prefixable')" },
			{ kind: "execute", sql: "INSERT INTO docs_fts(docs_fts) VALUES('rebuild')" },
		],
	});
	const tokenizerQueries = ["foo", "bar", "src", "file", "acción", "niño", "\"exact phrase\"", "prefix*"];
	const tokenizerCounts = Object.fromEntries(
		tokenizerQueries.map((query) => [query, scalar(handle, "SELECT count(*) FROM search_probe WHERE search_probe MATCH ?", [query])]),
	);
	record(
		gates,
		"fts5Tokenizer",
		tokenizerQueries.every((query) => tokenizerCounts[query] === 1n),
		"unicode61 must cover identifier/path splits, Unicode Spanish, exact phrases, and prefixes",
		tokenizerCounts,
	);
	record(gates, "fts5ExternalContentRebuild", scalar(handle, "SELECT count(*) FROM docs_fts WHERE docs_fts MATCH 'identifier'") === 1n, "external-content FTS rebuild must restore searchable projection");

	const payloadBytes = new TextEncoder().encode(fixture.payload.repeat(64));
	const compressed = Bun.zstdCompressSync(payloadBytes);
	handle.executeBatch({
		transactional: true,
		statements: [{
			kind: "execute",
			sql: "INSERT INTO payloads(codec, original_length, body, search_text) VALUES(?, ?, ?, ?)",
			parameters: ["zstd.v1", BigInt(payloadBytes.byteLength), compressed, fixture.payload],
		}],
	});
	const compressionRow = handle.executeBatch({
		transactional: false,
		statements: [{ kind: "query", sql: "SELECT codec, original_length, body FROM payloads", maxRows: 1 }],
	}).statements[0]?.rows[0];
	const storedCompressed = compressionRow?.[2];
	const decompressed = storedCompressed instanceof Uint8Array ? Bun.zstdDecompressSync(storedCompressed) : new Uint8Array();
	record(
		gates,
		"applicationZstd",
		compressionRow?.[0] === "zstd.v1"
			&& compressionRow[1] === BigInt(payloadBytes.byteLength)
			&& decompressed.byteLength === payloadBytes.byteLength
			&& decompressed.every((value, index) => value === payloadBytes[index])
			&& compressed.byteLength < payloadBytes.byteLength,
		"versioned application Zstd BLOB round-trips while search projection remains uncompressed",
		{ originalBytes: payloadBytes.byteLength, compressedBytes: compressed.byteLength },
	);
	gates.transparentCompression = {
		status: "unsupported",
		measured: true,
		detail: "Not selected: bridge deliberately does not expose WCDB transparent field compression because stock raw-SQL/export interoperability is opaque; application Zstd gate passed",
	};

	handle.checkpoint("truncate");
	handle.backup(backupPath);
	const backupHandle = loadWcdbNative({ libraryPath, databasePath: backupPath, readOnly: true, create: false });
	const backupCount = scalar(backupHandle, "SELECT count(*) FROM values_probe");
	const backupPayload = scalar(backupHandle, "SELECT body FROM payloads");
	const backupDecoded = backupPayload instanceof Uint8Array ? Bun.zstdDecompressSync(backupPayload) : new Uint8Array();
	backupHandle.close();
	record(gates, "backupReopen", backupCount === 1n && backupDecoded.byteLength === payloadBytes.byteLength, "checkpoint-close-copy backup must reopen and preserve rows/application codec");

	handle.close();
	const crashChild = await spawnChild("crash", libraryPath, databasePath);
	crashChild.kill(9);
	await crashChild.exited;
	handle = loadWcdbNative({ libraryPath, databasePath, create: false });
	record(gates, "reopenAfterCrash", scalar(handle, "SELECT count(*) FROM durability WHERE note='acknowledged-before-crash'") === 1n, "acknowledged commit must recover after SIGKILL with WAL/FULL");

	const lockChild = await spawnChild("lock", libraryPath, databasePath);
	const busyStarted = performance.now();
	let busyStatus: number | null = null;
	try {
		handle.executeBatch(
			{ transactional: true, statements: [{ kind: "execute", sql: "INSERT INTO durability(note) VALUES('blocked')" }] },
			{ timeoutMs: 250, cancellationToken: 0x42555359n },
		);
	} catch (error) {
		if (error instanceof WcdbNativeError) busyStatus = error.status;
	}
	const busyElapsedMs = performance.now() - busyStarted;
	lockChild.kill(9);
	await lockChild.exited;
	record(
		gates,
		"busyTimeoutAndCancellation",
		(busyStatus === 5 || busyStatus === 6) && busyElapsedMs >= 150 && busyElapsedMs < 2_000,
		"native deadline must interrupt a blocked writer within a bounded interval",
		{ status: busyStatus, elapsedMs: busyElapsedMs },
	);

	const healthBeforeClose = handle.health();
	handle.close();
	const healthAfterClose = handle.health();
	record(gates, "shutdown", !healthBeforeClose.closed && healthAfterClose.closed, "shutdown must close the owned handle and library deterministically");

	const importProbe = Bun.spawn([process.execPath, "-e", `import ${JSON.stringify(path.resolve(import.meta.dir, "../../../packages/coding-agent/src/storage/wcdb/native/index.ts"))}; process.stdout.write("JSONL_OK")`], {
		env: { ...process.env, OMP_WCDB_LIBRARY: path.join(runRoot, "missing-libWCDB.so") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const importStdout = await new Response(importProbe.stdout).text();
	const importStderr = await new Response(importProbe.stderr).text();
	const importExit = await importProbe.exited;
	record(gates, "lazyImport", importExit === 0 && importStdout === "JSONL_OK", "module import must not dlopen the configured missing library", { importExit, importStderr });

	const mandatory = [
		"ffiLoad",
		"wal",
		"synchronousFull",
		"foreignKeysEnabled",
		"foreignKeyEnforced",
		"busyTimeoutConfigured",
		"busyTimeoutAndCancellation",
		"int64BinaryUtf8",
		"fts5Tokenizer",
		"fts5ExternalContentRebuild",
		"applicationZstd",
		"backupReopen",
		"reopenAfterCrash",
		"shutdown",
		"lazyImport",
	];
	const enabled = mandatory.every((name) => gates[name]?.status === "pass");
	const receipt = {
		schemaVersion: 1,
		startedAt,
		completedAt: new Date().toISOString(),
		measured: true,
		fixture: { source: fixtureSource, copy: fixtureCopy, sha256: Bun.CryptoHasher.hash("sha256", await Bun.file(fixtureCopy).arrayBuffer(), "hex") },
		libraryPath,
		buildId: loadCapability.buildId,
		gates,
		mandatory,
		capability: { modeEnabled: enabled, releaseQualified: false, reason: enabled ? "Native gates pass only in clean local experimental staging; no production package/cutover was performed" : "One or more mandatory native gates failed" },
		environment: { bun: Bun.version, bunRevision: Bun.revision, platform: process.platform, arch: process.arch },
	};
	await Bun.write(receiptPath, `${JSON.stringify(receipt, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ enabled, receiptPath, gates: Object.fromEntries(Object.entries(gates).map(([name, gate]) => [name, gate.status])) })}\n`);
	if (!enabled) process.exitCode = 1;
}

if (childMode === "--child-crash" || childMode === "--child-lock") {
	await child(args[1]!, args[2]!, childMode === "--child-crash" ? "crash" : "lock");
} else {
	await main();
}
