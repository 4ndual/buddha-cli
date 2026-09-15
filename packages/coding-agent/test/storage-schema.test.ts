import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	IncompatibleSchemaError,
	WCDB_ENGINE_PIN,
	WCDB_LOGICAL_SCHEMA_VERSION,
	WCDB_SCHEMA_INVARIANT_AUDITS,
	WCDB_SCHEMA_MIGRATIONS,
	assertLogicalSchemaCompatible,
	assertSchemaCompatible,
	type StoredSchemaHeader,
} from "../src/storage/schema";
import { CANONICALIZER_VERSION } from "../src/storage/identity";

function createReferenceDatabase(): Database {
	const database = new Database(":memory:");
	for (const migration of WCDB_SCHEMA_MIGRATIONS) {
		for (const sql of migration.upSql) database.exec(sql);
	}
	return database;
}

function seedOrigin(database: Database, id: string): void {
	database
		.prepare(
			"INSERT INTO origins (origin_id, source_namespace, native_id, created_at, canonical_length, canonical_bytes) VALUES (?, 'omp', ?, '2026-09-15T00:00:00Z', 1, ?)",
		)
		.run(id, id, Uint8Array.of(1));
	database
		.prepare(
			"INSERT INTO payloads (payload_id, content_hash, codec, dictionary_id, uncompressed_length, encoded_length, chunk_count, media_type, canonical_length) VALUES (?, ?, 'identity', NULL, 0, 0, 0, 'application/json', 0)",
		)
		.run(`payload-${id}`, `hash-${id}`);
}

describe("WCDB logical schema", () => {
	it("pins immutable migration bytes with a checked SHA-256 receipt", () => {
		for (const migration of WCDB_SCHEMA_MIGRATIONS) {
			const hasher = new Bun.CryptoHasher("sha256");
			for (const sql of migration.upSql) hasher.update(sql);
			expect(`sha256:${hasher.digest("hex")}`).toBe(migration.checksum);
		}
	});

	it("executes on reference SQLite with every required logical table and invariant audit", () => {
		const database = createReferenceDatabase();
		try {
			const tables = database
				.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
				.all() as Array<{ name: string }>;
			const names = new Set(tables.map(row => row.name));
			for (const required of [
				"origins",
				"source_aliases",
				"events",
				"branches",
				"versions",
				"metadata_revisions",
				"metadata_observations",
				"payloads",
				"payload_chunks",
				"checkpoints",
				"search_documents",
				"search_fts",
				"import_jobs",
				"import_items",
				"replica_receipts",
				"export_jobs",
				"export_manifests",
				"source_manifests",
				"schema_migrations",
				"maintenance_state",
			]) {
				expect(names.has(required)).toBe(true);
			}
			for (const audit of WCDB_SCHEMA_INVARIANT_AUDITS) expect(database.prepare(audit.sql).all()).toEqual([]);
		} finally {
			database.close();
		}
	});

	it("enforces same-origin ancestry, immutable records, branch acyclicity, and restrictive foreign keys", () => {
		const database = createReferenceDatabase();
		try {
			seedOrigin(database, "origin-a");
			seedOrigin(database, "origin-b");
			const insertEvent = database.prepare(
				"INSERT INTO events (event_hash, origin_id, parent_hash, native_entry_id, kind, timestamp, payload_id, canonicalizer_version, canonical_length, canonical_bytes) VALUES (?, ?, ?, ?, 'message', '2026-09-15T00:00:00Z', ?, 1, 1, ?)",
			);
			insertEvent.run("event-a", "origin-a", null, "entry-a", "payload-origin-a", Uint8Array.of(1));
			insertEvent.run("event-b", "origin-b", null, "entry-b", "payload-origin-b", Uint8Array.of(2));
			expect(() =>
				insertEvent.run("event-bad-parent", "origin-b", "event-a", "entry-bad", "payload-origin-b", Uint8Array.of(3)),
			).toThrow("event parent must exist in the same origin");
			expect(() => database.run("UPDATE events SET native_entry_id = 'rewritten' WHERE event_hash = 'event-a'")).toThrow(
				"events are immutable",
			);

			const insertBranch = database.prepare(
				"INSERT INTO branches (branch_id, origin_id, parent_branch_id, fork_point_hash, head_hash, head_version_id, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 1, '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z')",
			);
			insertBranch.run("root", "origin-a", null, null, "event-a");
			insertBranch.run("child", "origin-a", "root", "event-a", "event-a");
			insertBranch.run("foreign", "origin-b", null, null, "event-b");
			expect(() => insertBranch.run("bad-head", "origin-a", null, null, "event-b")).toThrow(
				"branch head must exist in the same origin",
			);
			expect(() => insertBranch.run("bad-fork", "origin-a", null, "event-b", "event-a")).toThrow(
				"branch fork point must exist in the same origin",
			);
			expect(() => database.run("UPDATE branches SET parent_branch_id = 'foreign' WHERE branch_id = 'root'")).toThrow(
				"branch parent must exist in the same origin",
			);
			expect(() => database.run("UPDATE branches SET parent_branch_id = 'child' WHERE branch_id = 'root'")).toThrow(
				"branch cycle",
			);

			const insertMetadata = database.prepare(
				"INSERT INTO metadata_revisions (metadata_revision_id, origin_id, payload_id, semantic_hash, canonical_length, canonical_bytes, created_at) VALUES (?, ?, ?, ?, 1, ?, '2026-09-15T00:00:00Z')",
			);
			insertMetadata.run("metadata-a", "origin-a", "payload-origin-a", "metadata-hash-a", Uint8Array.of(1));
			insertMetadata.run("metadata-b", "origin-b", "payload-origin-b", "metadata-hash-b", Uint8Array.of(2));
			const insertVersion = database.prepare(
				"INSERT INTO versions (version_id, origin_id, branch_id, parent_version_id, head_hash, metadata_revision_id, created_at, canonical_length, canonical_bytes) VALUES (?, ?, ?, ?, ?, ?, '2026-09-15T00:00:00Z', 1, ?)",
			);
			insertVersion.run("version-a", "origin-a", "root", null, "event-a", "metadata-a", Uint8Array.of(1));
			insertVersion.run("version-b", "origin-b", "foreign", null, "event-b", "metadata-b", Uint8Array.of(2));
			expect(() =>
				insertVersion.run("bad-branch", "origin-a", "foreign", null, "event-a", "metadata-a", Uint8Array.of(3)),
			).toThrow("version branch must exist in the same origin");
			expect(() =>
				insertVersion.run("bad-parent", "origin-a", "child", "version-b", "event-a", "metadata-a", Uint8Array.of(4)),
			).toThrow("version parent must exist in the same origin");
			expect(() =>
				insertVersion.run("bad-head-version", "origin-a", "child", null, "event-b", "metadata-a", Uint8Array.of(5)),
			).toThrow("version head must exist in the same origin");
			expect(() =>
				insertVersion.run("bad-metadata", "origin-a", "child", null, "event-a", "metadata-b", Uint8Array.of(6)),
			).toThrow("version metadata must exist in the same origin");

			database.run("UPDATE branches SET head_version_id = 'version-a' WHERE branch_id = 'root'");
			expect(() => database.run("UPDATE branches SET head_version_id = 'version-a' WHERE branch_id = 'child'")).toThrow(
				"selected version must match branch origin and head",
			);
			for (const audit of WCDB_SCHEMA_INVARIANT_AUDITS) expect(database.prepare(audit.sql).all()).toEqual([]);
			expect(() => database.run("DELETE FROM origins WHERE origin_id = 'origin-a'")).toThrow();
		} finally {
			database.close();
		}
	});

	it("accepts only the pinned logical schema and exact source engine versions", () => {
		const stored: StoredSchemaHeader = {
			schemaVersion: WCDB_LOGICAL_SCHEMA_VERSION,
			minimumReaderVersion: WCDB_LOGICAL_SCHEMA_VERSION,
			maximumReaderVersion: WCDB_LOGICAL_SCHEMA_VERSION,
			canonicalizerVersion: CANONICALIZER_VERSION,
			wcdbVersion: WCDB_ENGINE_PIN.wcdbVersion,
			sqliteVersion: WCDB_ENGINE_PIN.bundledSqliteVersion,
		};
		expect(() => assertLogicalSchemaCompatible(stored)).not.toThrow();
		expect(() => assertLogicalSchemaCompatible({ ...stored, schemaVersion: 2 })).toThrow(IncompatibleSchemaError);
		expect(() => assertLogicalSchemaCompatible({ ...stored, canonicalizerVersion: 2 })).toThrow(
			IncompatibleSchemaError,
		);
		expect(() => assertSchemaCompatible(stored)).not.toThrow();
		expect(() => assertSchemaCompatible({ ...stored, sqliteVersion: "3.27.1" })).toThrow(
			"does not match pinned 3.27.2",
		);
		expect(WCDB_ENGINE_PIN.sourceVerified).toBe(true);
		expect(WCDB_ENGINE_PIN.runtimeVerified).toBe(false);
	});
});
