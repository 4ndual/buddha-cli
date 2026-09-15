import { CANONICALIZER_VERSION } from "../identity/canonical";

export const WCDB_LOGICAL_SCHEMA_VERSION = 1;
export const WCDB_MIN_READER_SCHEMA_VERSION = 1;
export const WCDB_MAX_READER_SCHEMA_VERSION = 1;

export interface EngineBuildPin {
	wcdbVersion: string;
	wcdbCommit: string;
	sourceArchive: string;
	sourceSha256: string;
	bundledSqliteVersion: string;
	bundledSqliteSourceId: string;
	sourceVerified: boolean;
	/** Runtime capability remains a separate native-lane gate. */
	runtimeVerified: boolean;
}

export const WCDB_ENGINE_PIN: EngineBuildPin = {
	wcdbVersion: "2.1.16",
	wcdbCommit: "df808591b9f9a9ab42156006819c3550d5af13a3",
	sourceArchive: "wcdb-2.1.16.zip",
	sourceSha256: "260845053c5dedc4578570203a5ba235c3be1e74a671c2fc1aeb12c988dd5346",
	bundledSqliteVersion: "3.27.2",
	bundledSqliteSourceId:
		"2019-02-25 16:06:06 bd49a8271d650fa89e446b42e513b595a717b9212c91dd384aab871fc1d0alt1",
	sourceVerified: true,
	runtimeVerified: false,
};

export interface SchemaMigration {
	version: number;
	name: string;
	checksum: string;
	upSql: readonly string[];
}

const CORE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE storage_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  minimum_reader_version INTEGER NOT NULL,
  maximum_reader_version INTEGER NOT NULL,
  canonicalizer_version INTEGER NOT NULL,
  replica_id TEXT NOT NULL,
  wcdb_version TEXT NOT NULL,
  sqlite_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  configuration_generation INTEGER NOT NULL DEFAULT 0 CHECK (configuration_generation >= 0)
) STRICT;

CREATE TABLE origins (
  origin_id TEXT PRIMARY KEY,
  source_namespace TEXT NOT NULL,
  native_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  canonical_length INTEGER NOT NULL CHECK (canonical_length > 0),
  canonical_bytes BLOB NOT NULL
) STRICT;

CREATE TABLE source_aliases (
  source_alias TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  harness TEXT NOT NULL,
  install_namespace TEXT NOT NULL,
  native_id TEXT NOT NULL,
  original_path TEXT,
  first_observed_at TEXT NOT NULL,
  UNIQUE (harness, install_namespace, native_id)
) STRICT;

CREATE TABLE payloads (
  payload_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  codec TEXT NOT NULL,
  dictionary_id TEXT,
  uncompressed_length INTEGER NOT NULL CHECK (uncompressed_length >= 0),
  encoded_length INTEGER NOT NULL CHECK (encoded_length >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  media_type TEXT,
  canonical_length INTEGER NOT NULL CHECK (canonical_length >= 0),
  UNIQUE (content_hash, codec, dictionary_id, uncompressed_length)
) STRICT;

CREATE TABLE payload_chunks (
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (payload_id, chunk_index),
  UNIQUE (payload_id, byte_offset)
) STRICT;

CREATE TABLE compression_dictionaries (
  dictionary_id TEXT PRIMARY KEY,
  codec TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  event_hash TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parent_hash TEXT REFERENCES events(event_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  native_entry_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  canonicalizer_version INTEGER NOT NULL,
  canonical_length INTEGER NOT NULL CHECK (canonical_length > 0),
  canonical_bytes BLOB NOT NULL,
  UNIQUE (origin_id, native_entry_id, event_hash)
) STRICT;

CREATE TABLE metadata_revisions (
  metadata_revision_id TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  semantic_hash TEXT NOT NULL,
  canonical_length INTEGER NOT NULL CHECK (canonical_length > 0),
  canonical_bytes BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (origin_id, semantic_hash, canonical_length)
) STRICT;

CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parent_branch_id TEXT REFERENCES branches(branch_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  fork_point_hash TEXT REFERENCES events(event_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  head_hash TEXT REFERENCES events(event_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  head_version_id TEXT REFERENCES versions(version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_branch_id IS NULL OR parent_branch_id <> branch_id)
) STRICT;

CREATE TABLE versions (
  version_id TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branches(branch_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parent_version_id TEXT REFERENCES versions(version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  head_hash TEXT REFERENCES events(event_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  metadata_revision_id TEXT NOT NULL REFERENCES metadata_revisions(metadata_revision_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  canonical_length INTEGER NOT NULL CHECK (canonical_length > 0),
  canonical_bytes BLOB NOT NULL,
  UNIQUE (origin_id, head_hash, metadata_revision_id),
  CHECK (parent_version_id IS NULL OR parent_version_id <> version_id)
) STRICT;

CREATE TABLE branch_mappings (
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  replica_id TEXT NOT NULL,
  source_alias TEXT NOT NULL REFERENCES source_aliases(source_alias) ON UPDATE RESTRICT ON DELETE RESTRICT,
  canonical_version_id TEXT NOT NULL REFERENCES versions(version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branches(branch_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (origin_id, replica_id, source_alias, canonical_version_id),
  UNIQUE (replica_id, source_alias, canonical_version_id, branch_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE metadata_observations (
  observation_id TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_id TEXT REFERENCES versions(version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  field_name TEXT NOT NULL,
  value_payload_id TEXT REFERENCES payloads(payload_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK (provenance IN ('source-recorded','externally-recorded','inferred','unknown')),
  observed_at TEXT NOT NULL,
  source_alias TEXT REFERENCES source_aliases(source_alias) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (origin_id, version_id, field_name, value_payload_id, provenance, observed_at)
) STRICT;

CREATE TABLE checkpoints (
  branch_id TEXT NOT NULL REFERENCES branches(branch_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  head_hash TEXT REFERENCES events(event_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  context_builder_version TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, head_hash, context_builder_version)
) WITHOUT ROWID, STRICT;

CREATE TABLE search_documents (
  event_hash TEXT PRIMARY KEY REFERENCES events(event_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  origin_id TEXT NOT NULL REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  role TEXT,
  timestamp TEXT NOT NULL,
  text TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE search_fts USING fts5(
  text,
  role UNINDEXED,
  timestamp UNINDEXED,
  origin_id UNINDEXED,
  event_hash UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0 tokenchars ''_./-'''
);

CREATE TABLE search_outbox (
  generation INTEGER PRIMARY KEY CHECK (generation >= 0),
  event_hash TEXT NOT NULL UNIQUE REFERENCES events(event_hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','rebuild')),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE import_jobs (
  job_id TEXT PRIMARY KEY,
  replica_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','cancel-requested','completed','failed','quarantined')),
  source_manifest_hash TEXT,
  durable_cursor TEXT,
  committed_items INTEGER NOT NULL DEFAULT 0 CHECK (committed_items >= 0),
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
) STRICT;

CREATE TABLE import_items (
  job_id TEXT NOT NULL REFERENCES import_jobs(job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  item_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','committed','duplicate','quarantined','excluded')),
  origin_id TEXT REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_id TEXT REFERENCES versions(version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  receipt_hash TEXT,
  error TEXT,
  PRIMARY KEY (job_id, item_key)
) WITHOUT ROWID, STRICT;

CREATE TABLE replica_receipts (
  replica_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('jsonl-to-db','db-to-jsonl','synchronize')),
  origin_id TEXT REFERENCES origins(origin_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_id TEXT REFERENCES versions(version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  manifest_hash TEXT,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, operation_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE export_jobs (
  job_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending','running','cancel-requested','completed','failed','quarantined')),
  scope TEXT NOT NULL,
  cutoff_generation INTEGER NOT NULL CHECK (cutoff_generation >= 0),
  durable_cursor TEXT,
  committed_items INTEGER NOT NULL DEFAULT 0 CHECK (committed_items >= 0),
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
) STRICT;

CREATE TABLE export_manifests (
  manifest_hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES export_jobs(job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  format_version INTEGER NOT NULL,
  cutoff_versions_payload_id TEXT NOT NULL REFERENCES payloads(payload_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  published_path TEXT,
  completion_marker_hash TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_manifests (
  manifest_hash TEXT PRIMARY KEY,
  source_root TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  payload_id TEXT NOT NULL REFERENCES payloads(payload_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  immutable INTEGER NOT NULL CHECK (immutable = 1)
) STRICT;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  rollback_snapshot_hash TEXT,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE maintenance_state (
  task TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  watermark INTEGER NOT NULL DEFAULT 0 CHECK (watermark >= 0),
  cursor TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT
) STRICT;

CREATE INDEX source_aliases_origin_idx ON source_aliases(origin_id);
CREATE INDEX source_aliases_native_idx ON source_aliases(harness, install_namespace, native_id);
CREATE INDEX events_parent_idx ON events(origin_id, parent_hash);
CREATE INDEX events_native_idx ON events(origin_id, native_entry_id);
CREATE INDEX events_payload_idx ON events(payload_id);
CREATE INDEX branches_origin_generation_idx ON branches(origin_id, generation DESC, branch_id);
CREATE INDEX branches_parent_idx ON branches(parent_branch_id);
CREATE INDEX branches_head_idx ON branches(origin_id, head_hash);
CREATE INDEX versions_branch_created_idx ON versions(branch_id, created_at DESC, version_id);
CREATE INDEX versions_parent_idx ON versions(parent_version_id);
CREATE INDEX metadata_observations_filter_idx ON metadata_observations(field_name, provenance, observed_at);
CREATE INDEX metadata_observations_origin_idx ON metadata_observations(origin_id, version_id);
CREATE INDEX checkpoints_lookup_idx ON checkpoints(branch_id, context_builder_version, created_at DESC);
CREATE INDEX search_documents_filter_idx ON search_documents(origin_id, role, timestamp);
CREATE INDEX import_items_source_idx ON import_items(source_hash, status);
CREATE INDEX receipts_origin_version_idx ON replica_receipts(origin_id, version_id);

CREATE TRIGGER events_parent_same_origin_before_insert
BEFORE INSERT ON events WHEN NEW.parent_hash IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM events parent
    WHERE parent.event_hash = NEW.parent_hash AND parent.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'event parent must exist in the same origin') END;
END;

CREATE TRIGGER events_cycle_before_update
BEFORE UPDATE OF parent_hash ON events WHEN NEW.parent_hash IS NOT OLD.parent_hash
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TRIGGER events_immutable_before_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TRIGGER events_immutable_before_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TRIGGER versions_immutable_before_update
BEFORE UPDATE ON versions
BEGIN
  SELECT RAISE(ABORT, 'versions are immutable');
END;

CREATE TRIGGER versions_immutable_before_delete
BEFORE DELETE ON versions
BEGIN
  SELECT RAISE(ABORT, 'versions are immutable');
END;

CREATE TRIGGER branches_origin_links_before_insert
BEFORE INSERT ON branches
BEGIN
  SELECT CASE WHEN NEW.parent_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM branches parent
    WHERE parent.branch_id = NEW.parent_branch_id AND parent.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch parent must exist in the same origin') END;
  SELECT CASE WHEN NEW.fork_point_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM events fork_point
    WHERE fork_point.event_hash = NEW.fork_point_hash AND fork_point.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch fork point must exist in the same origin') END;
  SELECT CASE WHEN NEW.head_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM events head
    WHERE head.event_hash = NEW.head_hash AND head.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch head must exist in the same origin') END;
  SELECT CASE WHEN NEW.head_version_id IS NOT NULL
    THEN RAISE(ABORT, 'new branch cannot select a version before the branch exists') END;
END;

CREATE TRIGGER branches_parent_cycle_before_update
BEFORE UPDATE OF parent_branch_id ON branches WHEN NEW.parent_branch_id IS NOT OLD.parent_branch_id
BEGIN
  SELECT CASE WHEN NEW.parent_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM branches parent
    WHERE parent.branch_id = NEW.parent_branch_id AND parent.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch parent must exist in the same origin') END;
  WITH RECURSIVE ancestors(branch_id) AS (
    SELECT NEW.parent_branch_id
    UNION ALL
    SELECT branches.parent_branch_id FROM branches JOIN ancestors USING (branch_id)
    WHERE branches.parent_branch_id IS NOT NULL
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM ancestors WHERE branch_id = NEW.branch_id)
    THEN RAISE(ABORT, 'branch cycle') END;
END;

CREATE TRIGGER branches_event_links_before_update
BEFORE UPDATE OF fork_point_hash, head_hash, head_version_id ON branches
BEGIN
  SELECT CASE WHEN NEW.fork_point_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM events fork_point
    WHERE fork_point.event_hash = NEW.fork_point_hash AND fork_point.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch fork point must exist in the same origin') END;
  SELECT CASE WHEN NEW.head_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM events head
    WHERE head.event_hash = NEW.head_hash AND head.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch head must exist in the same origin') END;
  SELECT CASE WHEN NEW.head_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM versions selected
    WHERE selected.version_id = NEW.head_version_id
      AND selected.origin_id = NEW.origin_id
      AND selected.branch_id = NEW.branch_id
      AND selected.head_hash IS NEW.head_hash
  ) THEN RAISE(ABORT, 'selected version must match branch origin and head') END;
END;

CREATE TRIGGER versions_origin_links_before_insert
BEFORE INSERT ON versions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM branches owning_branch
    WHERE owning_branch.branch_id = NEW.branch_id AND owning_branch.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'version branch must exist in the same origin') END;
  SELECT CASE WHEN NEW.parent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM versions parent
    WHERE parent.version_id = NEW.parent_version_id AND parent.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'version parent must exist in the same origin') END;
  SELECT CASE WHEN NEW.head_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM events head
    WHERE head.event_hash = NEW.head_hash AND head.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'version head must exist in the same origin') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM metadata_revisions metadata
    WHERE metadata.metadata_revision_id = NEW.metadata_revision_id AND metadata.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'version metadata must exist in the same origin') END;
END;

CREATE TRIGGER checkpoints_origin_links_before_insert
BEFORE INSERT ON checkpoints WHEN NEW.head_hash IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM branches
    JOIN events ON events.event_hash = NEW.head_hash AND events.origin_id = branches.origin_id
    WHERE branches.branch_id = NEW.branch_id
  ) THEN RAISE(ABORT, 'checkpoint head must belong to branch origin') END;
END;

CREATE TRIGGER search_documents_origin_before_insert
BEFORE INSERT ON search_documents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM events
    WHERE events.event_hash = NEW.event_hash AND events.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'search document must match event origin') END;
END;

CREATE TRIGGER metadata_observations_origin_before_insert
BEFORE INSERT ON metadata_observations
BEGIN
  SELECT CASE WHEN NEW.version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM versions
    WHERE versions.version_id = NEW.version_id AND versions.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'metadata observation version must match origin') END;
  SELECT CASE WHEN NEW.source_alias IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source_aliases
    WHERE source_aliases.source_alias = NEW.source_alias AND source_aliases.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'metadata observation alias must match origin') END;
END;

CREATE TRIGGER branch_mappings_origin_before_insert
BEFORE INSERT ON branch_mappings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_aliases
    WHERE source_aliases.source_alias = NEW.source_alias AND source_aliases.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch mapping alias must match origin') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM versions
    WHERE versions.version_id = NEW.canonical_version_id AND versions.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch mapping version must match origin') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM branches
    WHERE branches.branch_id = NEW.branch_id AND branches.origin_id = NEW.origin_id
  ) THEN RAISE(ABORT, 'branch mapping branch must match origin') END;
END;
`;

export const WCDB_SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
	{
		version: 1,
		name: "initial-session-repository",
		checksum: "sha256:887b890fa26c6f511d5a6809583271803bbd38a0ff2b15d99f259d9d89dbb4d9",
		upSql: [CORE_SCHEMA_SQL],
	},
];

export interface StoredSchemaHeader {
	schemaVersion: number;
	minimumReaderVersion: number;
	maximumReaderVersion: number;
	canonicalizerVersion: number;
	wcdbVersion: string;
	sqliteVersion: string;
}

export class IncompatibleSchemaError extends Error {
	readonly stored: StoredSchemaHeader;

	constructor(message: string, stored: StoredSchemaHeader) {
		super(message);
		this.name = "IncompatibleSchemaError";
		this.stored = stored;
	}
}

/** Refuses both unknown future schemas and old schemas requiring an explicit, snapshotted migration. */
export function assertLogicalSchemaCompatible(stored: StoredSchemaHeader): void {
	if (stored.schemaVersion < WCDB_MIN_READER_SCHEMA_VERSION || stored.minimumReaderVersion > WCDB_LOGICAL_SCHEMA_VERSION) {
		throw new IncompatibleSchemaError(
			`Schema ${stored.schemaVersion} is not readable by repository schema ${WCDB_LOGICAL_SCHEMA_VERSION}`,
			stored,
		);
	}
	if (stored.schemaVersion > WCDB_MAX_READER_SCHEMA_VERSION || stored.maximumReaderVersion < WCDB_LOGICAL_SCHEMA_VERSION) {
		throw new IncompatibleSchemaError(
			`Schema ${stored.schemaVersion} is incompatible with repository schema ${WCDB_LOGICAL_SCHEMA_VERSION}`,
			stored,
		);
	}
	if (stored.canonicalizerVersion !== CANONICALIZER_VERSION) {
		throw new IncompatibleSchemaError(
			`Canonicalizer ${stored.canonicalizerVersion} is incompatible with ${CANONICALIZER_VERSION}`,
			stored,
		);
	}
}

/** Adds exact native build compatibility to the logical schema gate. */
export function assertSchemaCompatible(stored: StoredSchemaHeader): void {
	assertLogicalSchemaCompatible(stored);
	if (stored.wcdbVersion !== WCDB_ENGINE_PIN.wcdbVersion) {
		throw new IncompatibleSchemaError(
			`WCDB ${stored.wcdbVersion} does not match pinned ${WCDB_ENGINE_PIN.wcdbVersion}`,
			stored,
		);
	}
	if (!WCDB_ENGINE_PIN.sourceVerified || stored.sqliteVersion !== WCDB_ENGINE_PIN.bundledSqliteVersion) {
		throw new IncompatibleSchemaError(
			`SQLite ${stored.sqliteVersion} does not match pinned ${WCDB_ENGINE_PIN.bundledSqliteVersion}`,
			stored,
		);
	}
}

export interface SchemaInvariantAudit {
	name: string;
	sql: string;
	/** Audit passes only when the query returns no rows. */
	expectsNoRows: true;
}

export const WCDB_SCHEMA_INVARIANT_AUDITS: readonly SchemaInvariantAudit[] = [
	{ name: "foreign-key-integrity", sql: "PRAGMA foreign_key_check", expectsNoRows: true },
	{
		name: "event-parent-origin",
		sql: `SELECT child.event_hash FROM events child JOIN events parent ON parent.event_hash = child.parent_hash WHERE child.origin_id <> parent.origin_id`,
		expectsNoRows: true,
	},
	{
		name: "event-cycles",
		sql: `WITH RECURSIVE ancestry(start_hash, event_hash, parent_hash, depth) AS (
  SELECT event_hash, event_hash, parent_hash, 0 FROM events
  UNION ALL
  SELECT ancestry.start_hash, parent.event_hash, parent.parent_hash, ancestry.depth + 1
  FROM ancestry JOIN events parent ON parent.event_hash = ancestry.parent_hash
  WHERE ancestry.depth <= (SELECT count(*) FROM events)
) SELECT DISTINCT start_hash FROM ancestry WHERE parent_hash = start_hash`,
		expectsNoRows: true,
	},
	{
		name: "branch-cycles",
		sql: `WITH RECURSIVE ancestry(start_id, branch_id, parent_branch_id, depth) AS (
  SELECT branch_id, branch_id, parent_branch_id, 0 FROM branches
  UNION ALL
  SELECT ancestry.start_id, parent.branch_id, parent.parent_branch_id, ancestry.depth + 1
  FROM ancestry JOIN branches parent ON parent.branch_id = ancestry.parent_branch_id
  WHERE ancestry.depth <= (SELECT count(*) FROM branches)
) SELECT DISTINCT start_id FROM ancestry WHERE parent_branch_id = start_id`,
		expectsNoRows: true,
	},
	{
		name: "version-cycles",
		sql: `WITH RECURSIVE ancestry(start_id, version_id, parent_version_id, depth) AS (
  SELECT version_id, version_id, parent_version_id, 0 FROM versions
  UNION ALL
  SELECT ancestry.start_id, parent.version_id, parent.parent_version_id, ancestry.depth + 1
  FROM ancestry JOIN versions parent ON parent.version_id = ancestry.parent_version_id
  WHERE ancestry.depth <= (SELECT count(*) FROM versions)
) SELECT DISTINCT start_id FROM ancestry WHERE parent_version_id = start_id`,
		expectsNoRows: true,
	},
	{
		name: "branch-head-origin",
		sql: `SELECT branches.branch_id FROM branches JOIN events ON events.event_hash = branches.head_hash WHERE branches.origin_id <> events.origin_id`,
		expectsNoRows: true,
	},
	{
		name: "branch-parent-origin",
		sql: `SELECT child.branch_id FROM branches child JOIN branches parent ON parent.branch_id = child.parent_branch_id WHERE child.origin_id <> parent.origin_id`,
		expectsNoRows: true,
	},
	{
		name: "branch-fork-origin",
		sql: `SELECT branches.branch_id FROM branches JOIN events ON events.event_hash = branches.fork_point_hash WHERE branches.origin_id <> events.origin_id`,
		expectsNoRows: true,
	},
	{
		name: "version-origin-links",
		sql: `SELECT versions.version_id FROM versions
JOIN branches ON branches.branch_id = versions.branch_id
JOIN metadata_revisions ON metadata_revisions.metadata_revision_id = versions.metadata_revision_id
LEFT JOIN events ON events.event_hash = versions.head_hash
LEFT JOIN versions parent ON parent.version_id = versions.parent_version_id
WHERE versions.origin_id <> branches.origin_id
   OR versions.origin_id <> metadata_revisions.origin_id
   OR (versions.head_hash IS NOT NULL AND versions.origin_id <> events.origin_id)
   OR (versions.parent_version_id IS NOT NULL AND versions.origin_id <> parent.origin_id)`,
		expectsNoRows: true,
	},
	{
		name: "checkpoint-head-origin",
		sql: `SELECT checkpoints.branch_id FROM checkpoints JOIN branches USING (branch_id) JOIN events ON events.event_hash = checkpoints.head_hash WHERE branches.origin_id <> events.origin_id`,
		expectsNoRows: true,
	},
	{
		name: "payload-chunk-accounting",
		sql: `SELECT payloads.payload_id FROM payloads LEFT JOIN payload_chunks USING (payload_id) GROUP BY payloads.payload_id HAVING count(payload_chunks.chunk_index) <> payloads.chunk_count OR coalesce(sum(length(payload_chunks.data)), 0) <> payloads.encoded_length`,
		expectsNoRows: true,
	},
	{
		name: "selected-version-head",
		sql: `SELECT branches.branch_id FROM branches JOIN versions ON versions.version_id = branches.head_version_id WHERE versions.origin_id <> branches.origin_id OR versions.branch_id <> branches.branch_id OR versions.head_hash IS NOT branches.head_hash`,
		expectsNoRows: true,
	},
];
