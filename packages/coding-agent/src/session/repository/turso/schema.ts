export const TURSO_SCHEMA_VERSION = 3;

export interface SchemaStatementResult {
	changes: number;
	lastInsertRowid: number | bigint;
}

export interface SchemaTransaction {
	exec(sql: string): Promise<void>;
	run(sql: string, ...parameters: unknown[]): Promise<SchemaStatementResult>;
	get<T>(sql: string, ...parameters: unknown[]): Promise<T | undefined>;
	all<T>(sql: string, ...parameters: unknown[]): Promise<T[]>;
}

export interface SchemaDatabase {
	get<T>(sql: string, ...parameters: unknown[]): Promise<T | undefined>;
	transactionAsync<T>(operation: (transaction: SchemaTransaction) => Promise<T>): Promise<T>;
}

export interface TursoSchemaMigration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
	readonly sql: string;
}

const CORE_SCHEMA_SQL = `
CREATE TABLE origins (
	origin_id TEXT PRIMARY KEY,
	source_namespace TEXT NOT NULL,
	native_id TEXT NOT NULL,
	created_at INTEGER NOT NULL CHECK (created_at >= 0),
	UNIQUE (source_namespace, native_id, origin_id)
);

CREATE TABLE source_aliases (
	source_namespace TEXT NOT NULL,
	native_id TEXT NOT NULL,
	origin_id TEXT NOT NULL REFERENCES origins(origin_id),
	observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
	PRIMARY KEY (source_namespace, native_id)
);

CREATE TABLE payloads (
	payload_id TEXT PRIMARY KEY,
	content_hash TEXT NOT NULL UNIQUE,
	codec TEXT NOT NULL,
	codec_version INTEGER NOT NULL CHECK (codec_version >= 1),
	uncompressed_length INTEGER NOT NULL CHECK (uncompressed_length >= 0),
	stored_length INTEGER NOT NULL CHECK (stored_length >= 0),
	chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
	media_type TEXT,
	created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE payload_chunks (
	payload_id TEXT NOT NULL REFERENCES payloads(payload_id),
	chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
	chunk_hash TEXT NOT NULL,
	data BLOB NOT NULL,
	PRIMARY KEY (payload_id, chunk_index)
);

CREATE TABLE events (
	event_hash TEXT PRIMARY KEY,
	origin_id TEXT NOT NULL REFERENCES origins(origin_id),
	parent_hash TEXT REFERENCES events(event_hash),
	native_entry_id TEXT,
	kind TEXT NOT NULL,
	timestamp INTEGER NOT NULL CHECK (timestamp >= 0),
	payload_id TEXT NOT NULL REFERENCES payloads(payload_id),
	canonicalizer_version INTEGER NOT NULL CHECK (canonicalizer_version >= 1),
	canonical_length INTEGER NOT NULL CHECK (canonical_length >= 0),
	CHECK (parent_hash IS NULL OR parent_hash <> event_hash)
);

CREATE TABLE metadata_revisions (
	metadata_revision_id TEXT PRIMARY KEY,
	origin_id TEXT NOT NULL REFERENCES origins(origin_id),
	payload_id TEXT NOT NULL REFERENCES payloads(payload_id),
	semantic_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL CHECK (created_at >= 0),
	UNIQUE (origin_id, semantic_hash)
);

CREATE TABLE metadata_observations (
	observation_id TEXT PRIMARY KEY,
	metadata_revision_id TEXT NOT NULL REFERENCES metadata_revisions(metadata_revision_id),
	field_name TEXT NOT NULL,
	value_payload_id TEXT REFERENCES payloads(payload_id),
	provenance_status TEXT NOT NULL CHECK (provenance_status IN ('source-recorded', 'externally-recorded', 'inferred', 'unknown')),
	source_reference TEXT,
	observed_at INTEGER NOT NULL CHECK (observed_at >= 0)
);

CREATE TABLE branches (
	branch_id TEXT PRIMARY KEY,
	origin_id TEXT NOT NULL REFERENCES origins(origin_id),
	parent_branch_id TEXT REFERENCES branches(branch_id),
	fork_point_hash TEXT REFERENCES events(event_hash),
	head_hash TEXT REFERENCES events(event_hash),
	head_version_id TEXT,
	generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
	created_at INTEGER NOT NULL CHECK (created_at >= 0),
	CHECK (parent_branch_id IS NULL OR parent_branch_id <> branch_id)
);

CREATE TABLE versions (
	version_id TEXT PRIMARY KEY,
	origin_id TEXT NOT NULL REFERENCES origins(origin_id),
	branch_id TEXT NOT NULL REFERENCES branches(branch_id),
	parent_version_id TEXT REFERENCES versions(version_id),
	head_hash TEXT REFERENCES events(event_hash),
	metadata_revision_id TEXT NOT NULL REFERENCES metadata_revisions(metadata_revision_id),
	created_at INTEGER NOT NULL CHECK (created_at >= 0),
	CHECK (parent_version_id IS NULL OR parent_version_id <> version_id)
);

CREATE TABLE checkpoints (
	checkpoint_key TEXT PRIMARY KEY,
	branch_id TEXT NOT NULL REFERENCES branches(branch_id),
	head_hash TEXT NOT NULL REFERENCES events(event_hash),
	metadata_revision_id TEXT NOT NULL REFERENCES metadata_revisions(metadata_revision_id),
	context_builder_version TEXT NOT NULL,
	context_hash TEXT NOT NULL,
	payload_id TEXT NOT NULL REFERENCES payloads(payload_id),
	created_at INTEGER NOT NULL CHECK (created_at >= 0),
	UNIQUE (branch_id, head_hash, metadata_revision_id, context_builder_version)
);

CREATE TABLE search_documents (
	event_hash TEXT PRIMARY KEY REFERENCES events(event_hash),
	origin_id TEXT NOT NULL REFERENCES origins(origin_id),
	role TEXT NOT NULL,
	event_time INTEGER NOT NULL CHECK (event_time >= 0),
	text TEXT NOT NULL
);

CREATE TABLE import_jobs (
	job_id TEXT PRIMARY KEY,
	replica_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'cancel-requested', 'completed', 'failed')),
	source_manifest_hash TEXT NOT NULL,
	cursor TEXT,
	committed_items INTEGER NOT NULL DEFAULT 0 CHECK (committed_items >= 0),
	committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
	created_at INTEGER NOT NULL CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE import_items (
	job_id TEXT NOT NULL REFERENCES import_jobs(job_id),
	item_id TEXT NOT NULL,
	source_fingerprint TEXT NOT NULL,
	origin_id TEXT REFERENCES origins(origin_id),
	version_id TEXT REFERENCES versions(version_id),
	state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'quarantined', 'failed')),
	disposition TEXT,
	PRIMARY KEY (job_id, item_id),
	UNIQUE (job_id, source_fingerprint)
);

CREATE TABLE replica_receipts (
	replica_id TEXT NOT NULL,
	origin_id TEXT NOT NULL REFERENCES origins(origin_id),
	canonical_version TEXT NOT NULL,
	version_id TEXT NOT NULL REFERENCES versions(version_id),
	branch_id TEXT NOT NULL REFERENCES branches(branch_id),
	received_at INTEGER NOT NULL CHECK (received_at >= 0),
	PRIMARY KEY (replica_id, origin_id, canonical_version)
);

CREATE TABLE export_jobs (
	job_id TEXT PRIMARY KEY,
	replica_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'cancel-requested', 'completed', 'failed')),
	cutoff_version_id TEXT REFERENCES versions(version_id),
	destination TEXT NOT NULL,
	created_at INTEGER NOT NULL CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE export_manifests (
	job_id TEXT NOT NULL REFERENCES export_jobs(job_id),
	generation INTEGER NOT NULL CHECK (generation >= 0),
	manifest_hash TEXT NOT NULL,
	published_at INTEGER,
	PRIMARY KEY (job_id, generation),
	UNIQUE (manifest_hash)
);

CREATE TABLE storage_fences (
	replica_id TEXT PRIMARY KEY,
	generation INTEGER NOT NULL CHECK (generation >= 0),
	token TEXT NOT NULL,
	committed_sequence INTEGER NOT NULL DEFAULT 0 CHECK (committed_sequence >= 0),
	updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE maintenance_state (
	name TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE INDEX source_aliases_origin_idx ON source_aliases(origin_id);
CREATE INDEX events_origin_parent_idx ON events(origin_id, parent_hash);
CREATE INDEX events_origin_native_idx ON events(origin_id, native_entry_id);
CREATE INDEX events_payload_idx ON events(payload_id);
CREATE INDEX branches_origin_generation_idx ON branches(origin_id, generation, branch_id);
CREATE INDEX branches_head_idx ON branches(head_hash);
CREATE INDEX versions_branch_created_idx ON versions(branch_id, created_at, version_id);
CREATE INDEX versions_origin_head_idx ON versions(origin_id, head_hash);
CREATE INDEX metadata_observations_revision_idx ON metadata_observations(metadata_revision_id, field_name);
CREATE INDEX search_documents_origin_time_idx ON search_documents(origin_id, event_time, event_hash);
CREATE INDEX search_documents_role_time_idx ON search_documents(role, event_time, event_hash);
CREATE INDEX import_items_fingerprint_idx ON import_items(source_fingerprint);
CREATE INDEX replica_receipts_branch_idx ON replica_receipts(replica_id, branch_id);
`;
const BOUNDED_BRANCH_EVENTS_SQL = `
CREATE TABLE branch_events (
	branch_id TEXT NOT NULL REFERENCES branches(branch_id),
	generation INTEGER NOT NULL CHECK (generation >= 0),
	event_hash TEXT NOT NULL REFERENCES events(event_hash),
	PRIMARY KEY (branch_id, generation),
	UNIQUE (branch_id, event_hash)
);



CREATE INDEX branch_events_event_branch_idx ON branch_events(event_hash, branch_id);
`;

const SEARCH_SCHEMA_SQL = `
CREATE INDEX search_documents_fts ON search_documents USING fts (text);
`;

export const TURSO_SCHEMA_MIGRATIONS: readonly TursoSchemaMigration[] = [
	{
		version: 1,
		name: "core-session-forest",
		checksum: "omp-turso-schema-v1-core-session-forest-fenced-2026-09-15",
		sql: CORE_SCHEMA_SQL,
	},
	{
		version: 2,
		name: "native-tantivy-search",
		checksum: "omp-turso-schema-v2-native-tantivy-default-search-2026-09-15",
		sql: SEARCH_SCHEMA_SQL,
	},
	{
		version: 3,
		name: "bounded-branch-event-pages",
		checksum: "omp-turso-schema-v3-bounded-branch-event-pages-2026-09-15",
		sql: BOUNDED_BRANCH_EVENTS_SQL,
	},
];

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version INTEGER PRIMARY KEY CHECK (version >= 1),
	name TEXT NOT NULL UNIQUE,
	checksum TEXT NOT NULL,
	applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
);
`;

interface MigrationRow {
	version: number | bigint;
	name: string;
	checksum: string;
}

async function backfillBranchEvents(transaction: SchemaTransaction): Promise<void> {
	const branches = await transaction.all<{ branch_id: string; head_hash: string | null }>(
		"SELECT branch_id, head_hash FROM branches WHERE head_hash IS NOT NULL ORDER BY branch_id",
	);
	for (const branch of branches) {
		const reversed: string[] = [];
		let eventHash = branch.head_hash;
		while (eventHash !== null) {
			reversed.push(eventHash);
			const event = await transaction.get<{ parent_hash: string | null }>(
				"SELECT parent_hash FROM events WHERE event_hash = ?",
				eventHash,
			);
			if (!event) throw new Error(`Cannot backfill missing Turso event ${eventHash}`);
			eventHash = event.parent_hash;
		}
		reversed.reverse();
		for (let generation = 0; generation < reversed.length; generation++) {
			await transaction.run(
				"INSERT INTO branch_events(branch_id, generation, event_hash) VALUES (?, ?, ?)",
				branch.branch_id,
				generation,
				reversed[generation],
			);
		}
		await transaction.run(
			"UPDATE branches SET generation = ? WHERE branch_id = ?",
			Math.max(0, reversed.length - 1),
			branch.branch_id,
		);
	}
}

export async function migrateTursoSchema(database: SchemaDatabase): Promise<number> {
	await database.transactionAsync(async transaction => {
		await transaction.exec(MIGRATION_TABLE_SQL);
	});

	const current = await database.get<{ version: number | bigint }>(
		"SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
	);
	const currentVersion = Number(current?.version ?? 0);
	if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
		throw new Error(`Invalid Turso schema version: ${String(current?.version)}`);
	}
	if (currentVersion > TURSO_SCHEMA_VERSION) {
		throw new Error(
			`Turso schema version ${currentVersion} is newer than supported version ${TURSO_SCHEMA_VERSION}; refusing to open`,
		);
	}

	for (const migration of TURSO_SCHEMA_MIGRATIONS) {
		const applied = await database.get<MigrationRow>(
			"SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
			migration.version,
		);
		if (applied) {
			if (applied.name !== migration.name || applied.checksum !== migration.checksum) {
				throw new Error(`Turso schema migration ${migration.version} does not match the pinned migration`);
			}
			continue;
		}
		if (migration.version <= currentVersion) {
			throw new Error(`Turso schema migration history has a gap at version ${migration.version}`);
		}
		await database.transactionAsync(async transaction => {
			await transaction.exec(migration.sql);
			if (migration.version === 3) await backfillBranchEvents(transaction);
			await transaction.run(
				"INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
				migration.version,
				migration.name,
				migration.checksum,
				Date.now(),
			);
		});
	}

	return TURSO_SCHEMA_VERSION;
}

export async function verifyTursoSchemaVersion(database: Pick<SchemaDatabase, "get">): Promise<number> {
	const current = await database.get<{ version: number | bigint }>(
		"SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
	);
	const currentVersion = Number(current?.version ?? 0);
	if (currentVersion !== TURSO_SCHEMA_VERSION) {
		throw new Error(
			`Turso schema version ${currentVersion} is not the required version ${TURSO_SCHEMA_VERSION}; refusing to open`,
		);
	}
	for (const migration of TURSO_SCHEMA_MIGRATIONS) {
		const applied = await database.get<MigrationRow>(
			"SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
			migration.version,
		);
		if (!applied || applied.name !== migration.name || applied.checksum !== migration.checksum) {
			throw new Error(`Turso schema migration ${migration.version} is missing or does not match the pinned migration`);
		}
	}
	return currentVersion;
}
