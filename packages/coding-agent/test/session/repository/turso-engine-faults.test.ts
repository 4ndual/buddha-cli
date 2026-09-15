import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	openLocalTursoDatabase,
	TURSO_SCHEMA_MIGRATIONS,
	TURSO_SCHEMA_VERSION,
	type TursoDatabase,
} from "../../../src/session/repository/turso/index";

const openDatabases = new Set<TursoDatabase>();

async function openFixtureDatabase(root: string, filename = "sessions.turso.db"): Promise<TursoDatabase> {
	const database = await openLocalTursoDatabase({ path: path.join(root, filename), allowedRoot: root });
	openDatabases.add(database);
	return database;
}

async function closeDatabase(database: TursoDatabase): Promise<void> {
	await database.close();
	openDatabases.delete(database);
}

async function waitForOutput(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (!output.includes(marker)) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`child exited before emitting ${marker}: ${output}`);
			output += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

afterEach(async () => {
	await Promise.all(Array.from(openDatabases, database => database.close().catch(() => {})));
	openDatabases.clear();
});

describe("embedded Turso transactional fault gates", () => {
	it("rolls back an interrupted transaction but recovers an acknowledged commit after reopen", async () => {
		using temp = TempDir.createSync("@omp-turso-transaction-");
		const dbPath = path.join(temp.path(), "sessions.turso.db");
		const database = await openFixtureDatabase(temp.path());
		await database.exec("CREATE TABLE receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");

		await expect(
			database.transactionAsync(async transaction => {
				await transaction.run("INSERT INTO receipts (id, payload) VALUES (?, ?)", "interrupted", "must rollback");
				throw new Error("injected transaction interruption");
			}),
		).rejects.toThrow("injected transaction interruption");
		expect(await database.all("SELECT id, payload FROM receipts ORDER BY id")).toEqual([]);

		await database.transactionAsync(async transaction => {
			await transaction.run("INSERT INTO receipts (id, payload) VALUES (?, ?)", "acknowledged", "must recover");
		});
		await closeDatabase(database);

		const reopened = await openLocalTursoDatabase({ path: dbPath, allowedRoot: temp.path() });
		openDatabases.add(reopened);
		expect(await reopened.all("SELECT id, payload FROM receipts ORDER BY id")).toEqual([
			{ id: "acknowledged", payload: "must recover" },
		]);
	}, 20_000);

	it("surfaces a busy writer and leaves the losing transaction unpublished", async () => {
		using temp = TempDir.createSync("@omp-turso-busy-");
		const first = await openFixtureDatabase(temp.path());
		await first.exec("CREATE TABLE writes (id TEXT PRIMARY KEY)");
		const second = await openFixtureDatabase(temp.path());

		await first.exec("BEGIN IMMEDIATE");
		await first.run("INSERT INTO writes (id) VALUES (?)", "held-by-first-writer");
		await expect(second.exec("BEGIN IMMEDIATE", { queryTimeout: 25 })).rejects.toThrow();
		await first.exec("ROLLBACK");

		expect(await second.all("SELECT id FROM writes ORDER BY id")).toEqual([]);
	}, 20_000);

	it("fails closed on corrupt database bytes without rewriting the evidence", async () => {
		using temp = TempDir.createSync("@omp-turso-corrupt-");
		const dbPath = path.join(temp.path(), "sessions.turso.db");
		const corruptBytes = new Uint8Array([0, 79, 77, 80, 255, 1, 2, 3, 4, 5, 6, 7]);
		await Bun.write(dbPath, corruptBytes);

		let observedError: unknown;
		let database: TursoDatabase | undefined;
		try {
			database = await openLocalTursoDatabase({ path: dbPath, allowedRoot: temp.path() });
			openDatabases.add(database);
			await database.get("SELECT name FROM sqlite_schema LIMIT 1");
		} catch (error) {
			observedError = error;
		} finally {
			if (database) await closeDatabase(database);
		}

		expect(observedError).toBeDefined();
		expect(new Uint8Array(await Bun.file(dbPath).arrayBuffer())).toEqual(corruptBytes);
	}, 20_000);

	it("returns bounded checkpoint accounting and preserves the checkpointed commit", async () => {
		using temp = TempDir.createSync("@omp-turso-checkpoint-");
		const database = await openFixtureDatabase(temp.path());
		await database.exec("CREATE TABLE checkpoint_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
		await database.run("INSERT INTO checkpoint_probe (value) VALUES (?)", "durable");

		const checkpoint = await database.checkpoint();
		expect(checkpoint.busy).toBeGreaterThanOrEqual(0);
		expect(checkpoint.logFrames).toBeGreaterThanOrEqual(0);
		expect(checkpoint.checkpointedFrames).toBeGreaterThanOrEqual(0);
		await closeDatabase(database);

		const reopened = await openFixtureDatabase(temp.path());
		expect(await reopened.get<{ value: string }>("SELECT value FROM checkpoint_probe WHERE id = 1")).toEqual({
			value: "durable",
		});
	}, 20_000);

	it("never silently loses an acknowledged commit after a killed writer leaves a corrupt WAL", async () => {
		using temp = TempDir.createSync("@omp-turso-corrupt-wal-");
		const dbPath = path.join(temp.path(), "sessions.turso.db");
		const childPath = path.join(temp.path(), "wal-writer.ts");
		const engineModule = path.resolve(import.meta.dir, "../../../src/session/repository/turso/index.ts");
		await Bun.write(
			childPath,
			`import { openLocalTursoDatabase } from ${JSON.stringify(engineModule)};
const database = await openLocalTursoDatabase({ path: ${JSON.stringify(dbPath)}, allowedRoot: ${JSON.stringify(temp.path())} });
await database.exec("CREATE TABLE acknowledged (id TEXT PRIMARY KEY)");
await database.run("INSERT INTO acknowledged (id) VALUES (?)", "acknowledged-before-kill");
console.log("COMMIT_ACKNOWLEDGED");
const hold = Promise.withResolvers();
await hold.promise;
`,
		);
		const child = Bun.spawn([process.execPath, childPath], {
			cwd: temp.path(),
			stdout: "pipe",
			stderr: "pipe",
		});
		await waitForOutput(child.stdout, "COMMIT_ACKNOWLEDGED");
		child.kill("SIGKILL");
		expect(await child.exited).not.toBe(0);
		const walName = (await fs.readdir(temp.path())).find(
			name => name.startsWith(path.basename(dbPath)) && name.toLowerCase().includes("wal"),
		);
		expect(walName).toBeDefined();
		if (!walName) throw new Error("expected engine-managed WAL after killed committed writer");
		const walPath = path.join(temp.path(), walName);
		const walBytes = new Uint8Array(await Bun.file(walPath).arrayBuffer());
		expect(walBytes.byteLength).toBeGreaterThan(32);
		const corrupted = walBytes.slice();
		corrupted[Math.floor(corrupted.byteLength / 2)] ^= 0xff;
		await Bun.write(walPath, corrupted);

		let error: unknown;
		let acknowledged: { id: string } | undefined;
		try {
			const reopened = await openLocalTursoDatabase({ path: dbPath, allowedRoot: temp.path() });
			openDatabases.add(reopened);
			acknowledged = await reopened.get<{ id: string }>(
				"SELECT id FROM acknowledged WHERE id = ?",
				"acknowledged-before-kill",
			);
		} catch (caught) {
			error = caught;
		}
		expect(error !== undefined || acknowledged?.id === "acknowledged-before-kill").toBe(true);
	}, 20_000);

	it("reports a missing native driver while JSONL remains independently loadable", async () => {
		using temp = TempDir.createSync("@omp-turso-driver-unavailable-");
		const childPath = path.join(temp.path(), "driver-unavailable.ts");
		const bundleDirectory = path.join(temp.path(), "isolated-engine");
		const engineModule = path.resolve(import.meta.dir, "../../../src/session/repository/turso/index.ts");
		const build = await Bun.build({
			entrypoints: [engineModule],
			outdir: bundleDirectory,
			target: "bun",
			external: ["@tursodatabase/database"],
		});
		expect(build.success).toBe(true);
		const isolatedEngineModule = build.outputs[0]?.path;
		if (!isolatedEngineModule) throw new Error("isolated engine bundle was not emitted");
		await Bun.write(
			childPath,
			`// Runtime-selected import is required: this bundle intentionally lives outside the workspace dependency tree.
const { openLocalTursoDatabase } = await import(${JSON.stringify(isolatedEngineModule)});
try {
	await openLocalTursoDatabase({
		path: ${JSON.stringify(path.join(temp.path(), "sessions.turso.db"))},
		allowedRoot: ${JSON.stringify(temp.path())},
	});
	throw new Error("database unexpectedly opened");
} catch (error) {
	const detail = String(error);
	if (!detail.includes("@tursodatabase/database") && !detail.includes("Cannot find package")) throw error;
}
`,
		);
		const child = Bun.spawn([process.execPath, "--no-install", childPath], {
			cwd: temp.path(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	}, 20_000);

	it("retries a killed schema upgrade from an atomic v1 state while retaining the pre-upgrade snapshot", async () => {
		using temp = TempDir.createSync("@omp-turso-upgrade-interrupt-");
		const dbPath = path.join(temp.path(), "sessions.turso.db");
		const backupPath = path.join(temp.path(), "pre-upgrade.turso.db");
		const database = await openFixtureDatabase(temp.path());
		const downgradeReady = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const downgrade = database.transactionAsync(async transaction => {
			await transaction.exec("DROP INDEX search_documents_fts");
			await transaction.run("DELETE FROM schema_migrations WHERE version = ?", TURSO_SCHEMA_VERSION);
			downgradeReady.resolve();
			await release.promise;
		});
		await downgradeReady.promise;

		const childPath = path.join(temp.path(), "upgrade.ts");
		const engineModule = path.resolve(import.meta.dir, "../../../src/session/repository/turso/index.ts");
		await Bun.write(
			childPath,
			`import { openLocalTursoDatabase } from ${JSON.stringify(engineModule)};
console.log("UPGRADE_OPENING");
const database = await openLocalTursoDatabase({
	path: ${JSON.stringify(dbPath)},
	allowedRoot: ${JSON.stringify(temp.path())},
	timeoutMs: 5000,
});
await database.close();
`,
		);
		const child = Bun.spawn([process.execPath, childPath], {
			cwd: temp.path(),
			stdout: "pipe",
			stderr: "pipe",
		});
		await waitForOutput(child.stdout, "UPGRADE_OPENING");
		child.kill("SIGKILL");
		expect(await child.exited).not.toBe(0);
		release.resolve();
		await downgrade;
		const downgradedVersion = await database.get<{ version: number | bigint; "0"?: number | bigint }>(
			"SELECT MAX(version) AS version FROM schema_migrations",
		);
		expect(Number(downgradedVersion?.version ?? downgradedVersion?.["0"])).toBe(1);
		expect(
			await database.get("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'search_documents_fts'"),
		).toBeUndefined();
		const backup = await database.closeAndBackup(backupPath, temp.path());
		openDatabases.delete(database);
		expect(backup.closedBeforeCopy).toBe(true);

		const upgraded = await openLocalTursoDatabase({ path: dbPath, allowedRoot: temp.path() });
		openDatabases.add(upgraded);
		expect(upgraded.schemaVersion).toBe(TURSO_SCHEMA_VERSION);
		expect(
			await upgraded.get<{ name: string }>(
				"SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'search_documents_fts'",
			),
		).toEqual({ name: "search_documents_fts" });
		expect(
			await upgraded.get<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = ?", 2),
		).toEqual({ checksum: TURSO_SCHEMA_MIGRATIONS[1].checksum });
		await expect(
			openLocalTursoDatabase({
				path: backupPath,
				allowedRoot: temp.path(),
				readonly: true,
				migrate: false,
				fileMustExist: true,
			}),
		).rejects.toThrow("not the required version");
	}, 20_000);
});
