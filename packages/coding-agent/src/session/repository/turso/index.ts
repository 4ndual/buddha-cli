export {
	probeTursoCapabilities,
	type ProbeTursoCapabilitiesOptions,
	type TursoCapabilityReport,
	type TursoCapabilityResult,
	type TursoCapabilityStatus,
	type TursoFeasibilityApproach,
} from "./capabilities";
export {
	openLocalTursoDatabase,
	TURSO_DATABASE_PACKAGE_VERSION,
	TURSO_NATIVE_PACKAGE_VERSION,
	TURSO_VALIDATED_BUN_VERSION,
	tursoDatabaseModeCanActivate,
	TURSO_SCHEMA_VERSION,
	TursoDatabase,
	type OpenLocalTursoDatabaseOptions,
	type TursoBackupReceipt,
	type TursoCheckpointResult,
	type TursoPreparedStatement,
	type TursoTransaction,
	type TursoTransactionMode,
} from "./database";
export {
	deleteTursoSearchDocument,
	optimizeTursoSearchIndex,
	searchTursoDocuments,
	TURSO_SEARCH_INDEX_NAME,
	upsertTursoSearchDocument,
	verifyTursoSearchIndex,
	type TursoSearchDocument,
	type TursoSearchHit,
	type TursoSearchPage,
	type TursoSearchRequest,
} from "./fts";
export {
	migrateTursoSchema,
	TURSO_SCHEMA_MIGRATIONS,
	verifyTursoSchemaVersion,
	type SchemaDatabase,
	type SchemaStatementResult,
	type SchemaTransaction,
	type TursoSchemaMigration,
} from "./schema";
export {
	EmbeddedTursoRuntimeAdapter,
	createEmbeddedTursoRuntimeAdapter,
	openEmbeddedTursoRuntimeAdapter,
	type EmbeddedTursoRuntimeAdapterOptions,
	type OpenEmbeddedTursoRuntimeAdapterOptions,
} from "./embedded-adapter";
export * from "./repository";
