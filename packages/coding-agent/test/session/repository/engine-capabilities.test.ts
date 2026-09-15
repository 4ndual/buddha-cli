import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	openLocalTursoDatabase,
	tursoDatabaseModeCanActivate,
	TURSO_SCHEMA_VERSION,
} from "../../../src/session/repository/turso";

const roots: string[] = [];

async function makeOwnedRoot(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "omp-turso-engine-test-"));
	roots.push(root);
	return root;
}

afterAll(async () => {
	await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

describe("embedded Turso engine gate", () => {
	test("rejects non-file and out-of-root targets before connection", async () => {
		const root = await makeOwnedRoot();
		for (const databasePath of ["https://example.turso.io/db", "libsql://example/db", "file:relative.db", ":memory:"]) {
			await expect(openLocalTursoDatabase({ path: databasePath, allowedRoot: root })).rejects.toThrow(
				"must be a local file path",
			);
		}
		await expect(
			openLocalTursoDatabase({ path: path.join(path.dirname(root), "escape.db"), allowedRoot: root }),
		).rejects.toThrow("escapes allowed root");
	});

	test("applies the pinned schema and refuses a future schema version", async () => {
		const root = await makeOwnedRoot();
		const databasePath = path.join(root, "schema.db");
		const database = await openLocalTursoDatabase({ path: databasePath, allowedRoot: root, migrate: true });
		expect(database.schemaVersion).toBe(TURSO_SCHEMA_VERSION);
		const rows = await database.all<{ version: bigint }>("SELECT version FROM schema_migrations ORDER BY version");
		expect(rows.map(row => Number(row.version))).toEqual([1, 2]);
		await database.run(
			"INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (99, 'future', 'future', ?)",
			Date.now(),
		);
		await database.close();

		await expect(
			openLocalTursoDatabase({
				path: databasePath,
				allowedRoot: root,
				readonly: true,
				fileMustExist: true,
				migrate: false,
			}),
		).rejects.toThrow("not the required version");
	});

	test("keeps database mode disabled for any failed mandatory capability", () => {
		expect(tursoDatabaseModeCanActivate({ databaseModeEnabled: false })).toBe(false);
		expect(tursoDatabaseModeCanActivate({ databaseModeEnabled: true })).toBe(true);
	});
});
