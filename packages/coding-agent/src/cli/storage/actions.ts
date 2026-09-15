import {
	exportLogicalBundle,
	selectLogicalBundle,
	type LogicalExportSource,
} from "../../session/repository/migration/export";
import type { StorageAction } from "./model";
import { StorageCommandRejectedError, type StorageCommandRequest, type StorageMigrationController } from "./storage-cli";

export type StoragePanelActionId =
	| "status"
	| "create"
	| "open"
	| "copy"
	| "normalize-copy"
	| "import"
	| "export"
	| "sync"
	| "migrate"
	| "adopt"
	| "verify"
	| "repair"
	| "backup"
	| "rollback"
	| "recover"
	| "mode";

export interface StoragePanelActionDefinition {
	id: StoragePanelActionId;
	action: StorageAction;
	label: string;
	description: string;
	requiresSource: boolean;
	requiresDestination: boolean;
	writes: boolean;
	requiresFreshBackup: boolean;
	previewOnly: boolean;
}

export const STORAGE_PANEL_ACTIONS: readonly StoragePanelActionDefinition[] = [
	{
		id: "status",
		action: "status",
		label: "Refresh status",
		description: "Refresh mode, engine, schema, counts, size, WAL, and health without scanning JSONL",
		requiresSource: false,
		requiresDestination: false,
		writes: false,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "create",
		action: "create",
		label: "Create database",
		description: "Create a new local embedded Turso database at an explicit destination",
		requiresSource: false,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "open",
		action: "open",
		label: "Open database",
		description: "Inspect an explicitly selected database without adopting it as the active backend",
		requiresSource: true,
		requiresDestination: false,
		writes: false,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "copy",
		action: "copy-as-is",
		label: "Copy as-is",
		description: "Copy an explicit source into staging without normalization or activation",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "normalize-copy",
		action: "normalize-copy",
		label: "Normalize copy",
		description: "Normalize an explicit source into a new staging destination",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "import",
		action: "import",
		label: "Import JSONL → DB",
		description: "Import a selected normalized source through the fenced transfer adapter",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "export",
		action: "export",
		label: "Export DB → JSONL",
		description: "Publish a verified logical bundle from a consistent repository snapshot",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "sync",
		action: "sync",
		label: "Synchronize both",
		description: "Preview and preserve extensions, siblings, duplicates, and quarantines without merging",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "migrate",
		action: "migrate",
		label: "Migrate",
		description: "Prepare a migration into staging; never commits the active mode",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: true,
		previewOnly: false,
	},
	{
		id: "adopt",
		action: "adopt",
		label: "Adopt staged database",
		description: "Verify an adoption candidate; active configuration cutover remains unavailable",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: true,
		previewOnly: true,
	},
	{
		id: "verify",
		action: "verify",
		label: "Verify",
		description: "Run integrity and transfer checks against explicit paths",
		requiresSource: true,
		requiresDestination: true,
		writes: false,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "repair",
		action: "repair",
		label: "Repair",
		description: "Repair a verified copy only after a fresh backup has been validated",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: true,
		previewOnly: false,
	},
	{
		id: "backup",
		action: "backup",
		label: "Backup",
		description: "Create and verify a consistent local logical backup",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: false,
		previewOnly: false,
	},
	{
		id: "rollback",
		action: "rollback",
		label: "Rollback",
		description: "Restore from a verified fresh backup without changing storage mode",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: true,
		previewOnly: false,
	},
	{
		id: "recover",
		action: "recover",
		label: "Recover export receipt",
		description: "Verify a published export and recover its interrupted durable receipt",
		requiresSource: true,
		requiresDestination: true,
		writes: true,
		requiresFreshBackup: true,
		previewOnly: false,
	},
	{
		id: "mode",
		action: "mode",
		label: "Preview mode switch",
		description: "Prepare, drain, synchronize, and verify; configuration commit is unavailable",
		requiresSource: false,
		requiresDestination: false,
		writes: false,
		requiresFreshBackup: false,
		previewOnly: true,
	},
] as const;

export function storagePanelAction(id: StoragePanelActionId): StoragePanelActionDefinition {
	const definition = STORAGE_PANEL_ACTIONS.find(action => action.id === id);
	if (!definition) throw new Error(`Unknown storage panel action: ${id}`);
	return definition;
}

export function storageActionRequiresFreshBackup(action: StorageAction): boolean {
	return action === "migrate" || action === "adopt" || action === "repair" || action === "rollback" || action === "recover";
}

export function storageActionWrites(action: StorageAction): boolean {
	return STORAGE_PANEL_ACTIONS.some(definition => definition.action === action && definition.writes);
}

/**
 * Real export adapter used by the storage panel once a runtime supplies a repository snapshot source.
 * The source remains an explicit dependency so merely opening the panel cannot initialize Turso.
 */
export function createLogicalExportStorageController(
	source: LogicalExportSource,
	maxBatchBytes = 8 * 1024 * 1024,
): StorageMigrationController {
	return {
		async preview(request) {
			if (request.action !== "export" && request.action !== "backup") {
				throw new StorageCommandRejectedError(`Logical export adapter cannot execute ${request.action}`);
			}
			const snapshot = await source.readLogicalSnapshot();
			const selected = selectLogicalBundle(snapshot, { allBranches: request.allBranches });
			return {
				message: `Verified logical ${request.action} preview`,
				counts: {
					origins: selected.origins.length,
					branches: selected.branches.length,
					versions: selected.versions.length,
					events: selected.events.length,
				},
				details: { writes: false, source: request.source, destination: request.destination },
			};
		},
		async execute(request) {
			if (request.action !== "export" && request.action !== "backup") {
				throw new StorageCommandRejectedError(`Logical export adapter cannot execute ${request.action}`);

			}
			if (!request.allowedRoot || !request.destination || !request.jobId || !request.journalPath || !request.generationId) {
				throw new StorageCommandRejectedError(
					`${request.action} requires --allowed-root, --destination, --job-id, --journal, and --generation-id`,
				);
			}
			const result = await exportLogicalBundle(source, {
				jobId: request.jobId,
				journalPath: request.journalPath,
				allowedRoot: request.allowedRoot,
				destination: request.destination,
				generationId: request.generationId,
				maxBatchBytes,
				selection: { allBranches: request.allBranches },
			});
			return {
				message: `Published verified ${request.action} generation`,
				counts: {
					origins: result.bundle.origins.length,
					branches: result.bundle.branches.length,
					versions: result.bundle.versions.length,
					events: result.bundle.events.length,
				},
				details: {
					publicationPath: result.publication.path,
					manifestSha256: result.publication.manifestSha256,
					generationId: result.publication.manifest.generation_id,
				},
			};
		},
	};
}
export function shouldLaunchStoragePanel(
	action: string | undefined,
	panelRequested: boolean,
	machineOutput: boolean,
	stdinIsTty: boolean,
	stdoutIsTty: boolean,
): boolean {
	if (machineOutput || !stdinIsTty || !stdoutIsTty) return false;
	return panelRequested || action === undefined;
}

export function describeConfirmedPaths(request: Readonly<StorageCommandRequest>): string {
	const paths = [request.source && `source=${request.source}`, request.destination && `destination=${request.destination}`].filter(
		(value): value is string => Boolean(value),
	);
	return paths.length > 0 ? paths.join("; ") : "no source or destination paths";
}
