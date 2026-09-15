import type { ExportCutoff, ExportGenerationFile, ExportPublicationReceipt, ExportReceiptStore } from "../jobs/export-generation";
import { publishExportGeneration } from "../jobs/export-generation";
import { PINNED_RECOVERY_SCHEMA_VERSION, assertReadableSchema } from "./schema-gate";

interface RecoveryBase {
	destinationRoot: string;
	generation: string;
	receipts: ExportReceiptStore;
	validate(directory: string): Promise<void>;
}

export interface JsonlStandaloneRecovery extends RecoveryBase {
	mode: "jsonl";
	schemaVersion: typeof PINNED_RECOVERY_SCHEMA_VERSION;
	files: AsyncIterable<ExportGenerationFile>;
	cutoffs: readonly ExportCutoff[];
}

export interface DatabaseRecoverySource {
	schemaVersion(): Promise<number>;
	exportFiles(): Promise<{
		files: AsyncIterable<ExportGenerationFile>;
		cutoffs: readonly ExportCutoff[];
	}>;
	close(): Promise<void>;
}

export interface DatabaseStandaloneRecovery extends RecoveryBase {
	mode: "db";
	schemaVersion: number;
	openDatabase(): Promise<DatabaseRecoverySource>;
}

export type StandaloneRecoveryRequest = JsonlStandaloneRecovery | DatabaseStandaloneRecovery;

/**
 * Standalone pinned-schema evacuation entry. The JSONL branch is selected before any database
 * factory is referenced, so native driver absence cannot prevent JSONL recovery.
 */
export async function runStandaloneRecovery(request: StandaloneRecoveryRequest): Promise<ExportPublicationReceipt> {
	if (request.mode === "jsonl") {
		assertReadableSchema(request.schemaVersion);
		return publishExportGeneration({
			root: request.destinationRoot,
			generation: request.generation,
			publication: "same-filesystem",
			cutoffs: request.cutoffs,
			files: request.files,
			receipts: request.receipts,
			validate: async directory => request.validate(directory),
		});
	}

	assertReadableSchema(request.schemaVersion);
	const database = await request.openDatabase();
	try {
		const actualSchema = await database.schemaVersion();
		assertReadableSchema(actualSchema, request.schemaVersion);
		const exported = await database.exportFiles();
		return await publishExportGeneration({
			root: request.destinationRoot,
			generation: request.generation,
			publication: "same-filesystem",
			cutoffs: exported.cutoffs,
			files: exported.files,
			receipts: request.receipts,
			validate: async directory => request.validate(directory),
		});
	} finally {
		await database.close();
	}
}
