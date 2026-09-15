import {
	assertNoSymlinkComponents,
	prepareDrainVerifyTransition,
	readFenceState,
	type TransitionSteps,
} from "../../session/repository/migration/fencing";
import { recoverPublishedExport } from "../../session/repository/migration/recovery";
import { verifyPublishedBundle } from "../../session/repository/migration/bundle";
import {
	createDisabledStorageControlModel,
	DISABLED_DATABASE_REASON,
	type StorageAction,
	type StorageControlModel,
	type StorageMode,
} from "./model";
import {
	formatStorageReportJson,
	formatStorageReportText,
	STORAGE_REPORT_SCHEMA,
	type StorageReport,
} from "./report";

const STORAGE_ACTIONS: Record<StorageAction, true> = {
	inventory: true,
	create: true,
	open: true,
	"copy-as-is": true,
	normalize: true,
	"normalize-copy": true,
	import: true,
	export: true,
	sync: true,
	verify: true,
	repair: true,
	backup: true,
	rollback: true,
	recover: true,
	migrate: true,
	adopt: true,
	mode: true,
	status: true,
};

const MIGRATION_ACTIONS: Partial<Record<StorageAction, true>> = {
	inventory: true,
	create: true,
	open: true,
	"copy-as-is": true,
	normalize: true,
	"normalize-copy": true,
	import: true,
	export: true,
	sync: true,
	verify: true,
	repair: true,
	backup: true,
	rollback: true,
	recover: true,
	migrate: true,
	adopt: true,
};
const MUTATING_REPOSITORY_ACTIONS: Partial<Record<StorageAction, true>> = {
	import: true,
	sync: true,
	migrate: true,
};

const WRITING_ACTIONS: Partial<Record<StorageAction, true>> = {
	create: true,
	"copy-as-is": true,
	normalize: true,
	"normalize-copy": true,
	import: true,
	export: true,
	sync: true,
	repair: true,
	backup: true,
	rollback: true,
	recover: true,
	migrate: true,
	adopt: true,
};

const FRESH_BACKUP_ACTIONS: Partial<Record<StorageAction, true>> = {
	repair: true,
	rollback: true,
	recover: true,
	migrate: true,
	adopt: true,
};

const SOURCE_ONLY_ACTIONS: Partial<Record<StorageAction, true>> = {
	inventory: true,
	open: true,
};
const DESTINATION_ONLY_ACTIONS: Partial<Record<StorageAction, true>> = {
	create: true,
};
const SOURCE_AND_DESTINATION_ACTIONS: Partial<Record<StorageAction, true>> = {
	"copy-as-is": true,
	normalize: true,
	"normalize-copy": true,
	import: true,
	export: true,
	sync: true,
	verify: true,
	repair: true,
	backup: true,
	rollback: true,
	recover: true,
	migrate: true,
	adopt: true,
};

export interface StorageCommandRequest {
	action: StorageAction;
	source?: string;
	destination?: string;
	allowedRoot?: string;
	fencePath?: string;
	journalPath?: string;
	generationId?: string;
	dryRun?: boolean;
	allBranches?: boolean;
	jobId?: string;
	cancelAfterCurrentBatch?: boolean;
	resume?: boolean;
	requestedMode?: StorageMode;
	expectedGeneration?: number;
	expectedNonce?: string;
	machine?: boolean;
	pathsConfirmed?: boolean;
	secondConfirmation?: boolean;
	backupReceipt?: string;
}

export interface StorageOperationResult {
	message: string;
	counts?: Readonly<Record<string, number>>;
	details?: Readonly<Record<string, unknown>>;
}

/**
 * Migration executor loaded only for an explicit storage migration action.
 * Implementations may load the native driver for DB operations here; status,
 * JSONL startup, and mode previews never request this dependency.
 */
export interface StorageMigrationController {
	preview(request: Readonly<StorageCommandRequest>): Promise<StorageOperationResult>;
	execute(request: Readonly<StorageCommandRequest>): Promise<StorageOperationResult>;
}

export interface StorageCommandDependencies {
	getStatus(request: Readonly<StorageCommandRequest>): Promise<StorageControlModel>;
	loadMigrationController(request: Readonly<StorageCommandRequest>): Promise<StorageMigrationController>;
	loadTransitionSteps(
		request: Readonly<StorageCommandRequest>,
		status: Readonly<StorageControlModel>,
	): Promise<TransitionSteps>;
	previewModeTransition(
		request: Readonly<StorageCommandRequest>,
		status: Readonly<StorageControlModel>,
		steps?: TransitionSteps,
	): Promise<StorageOperationResult>;
	writeStdout(text: string): void;
}

export class StorageCommandRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageCommandRejectedError";
	}
}

const defaultMigrationController: StorageMigrationController = {
	async preview(request) {
		if (request.action === "recover") {
			if (!request.allowedRoot || !request.source || !request.destination) {
				throw new StorageCommandRejectedError(
					"recover requires --allowed-root, --source <published bundle>, and --destination <job journal>",
				);
			}
			const publishedPath = await assertNoSymlinkComponents(request.allowedRoot, request.source);
			const verified = await verifyPublishedBundle(publishedPath, { allowedRoot: request.allowedRoot });
			return {
				message: "Verified published export recovery preview; no journal receipt was written",
				counts: {
					origins: verified.bundle.origins.length,
					branches: verified.bundle.branches.length,
					versions: verified.bundle.versions.length,
					events: verified.bundle.events.length,
				},
				details: {
					allowedRoot: request.allowedRoot,
					publishedPath: request.source,
					journalPath: request.destination,
					manifestSha256: verified.manifestSha256,
					backupReceipt: verified.manifestSha256,
					writes: false,
				},
			};
		}
		return {
			message: `${request.action} preview created; execution remains disabled until a repository migration controller is installed`,
			details: { executionEnabled: false, writes: false },
		};
	},
	async execute(request) {
		if (request.action !== "recover") {
			throw new StorageCommandRejectedError(
				"Storage migration execution is disabled until the repository migration controller is installed",
			);
		}
		if (!request.allowedRoot || !request.source || !request.destination) {
			throw new StorageCommandRejectedError(
				"recover requires --allowed-root, --source <published bundle>, and --destination <job journal>",
			);
		}
		const recovered = await recoverPublishedExport({
			allowedRoot: request.allowedRoot,
			publishedPath: request.source,
			journalPath: request.destination,
		});
		return {
			message:
				recovered.status === "already-recorded"
					? "Verified recovery receipt was already recorded"
					: "Recovered the verified published export receipt",
			counts: { recoveredReceipts: recovered.status === "receipt-recovered" ? 1 : 0 },
			details: {
				jobId: recovered.job.job_id,
				manifestSha256: recovered.manifestSha256,
				recoveryStatus: recovered.status,
			},
		};
	},
};

export const defaultStorageCommandDependencies: StorageCommandDependencies = {
	async getStatus(request) {
		const status = createDisabledStorageControlModel();
		if (!request.fencePath) return status;
		const fence = await readFenceState(request.fencePath);
		status.activeMode = fence.active_mode;
		status.defaultMode = fence.active_mode;
		status.configurationGeneration = fence.generation;
		status.generationToken = { generation: fence.generation, nonce: fence.nonce };
		if (fence.state !== "stable" && fence.target_mode && fence.transition_id) {
			status.preparedTransition = {
				state: fence.state,
				targetMode: fence.target_mode,
				transitionId: fence.transition_id,
				verificationReceipt: fence.verification_receipt ?? undefined,
			};
		}
		return status;
	},
	async loadMigrationController() {
		return defaultMigrationController;
	},
	async loadTransitionSteps() {
		throw new StorageCommandRejectedError(
			"Mode preparation requires real drain, synchronize, and verify transition steps",
		);
	},
	async previewModeTransition(request, status, steps) {
		if (
			!request.fencePath ||
			request.expectedGeneration === undefined ||
			!request.expectedNonce ||
			!request.requestedMode
		) {
			throw new StorageCommandRejectedError(
				"Mode preparation requires --fence, --expected-generation, and --expected-nonce",
			);
		}
		if (!steps) {
			throw new StorageCommandRejectedError(
				"Mode preparation requires real drain, synchronize, and verify transition steps",
			);
		}
		const prepared = await prepareDrainVerifyTransition(
			request.fencePath,
			{ generation: request.expectedGeneration, nonce: request.expectedNonce },
			request.requestedMode,
			steps,
		);
		return {
			message: `Prepared, drained, synchronized, and verified ${status.activeMode} → ${request.requestedMode}; active configuration was not changed`,
			details: {
				configurationMutated: false,
				from: prepared.fromMode,
				target: prepared.targetMode,
				transitionId: prepared.transitionId,
				verificationReceipt: prepared.verificationReceipt,
			},
		};
	},
	writeStdout(text) {
		process.stdout.write(text);
	},
};
export function parseStorageAction(value: string | undefined): StorageAction | undefined {
	if (value === undefined) return "status";
	return Object.hasOwn(STORAGE_ACTIONS, value) ? (value as StorageAction) : undefined;
}

export function parseStorageMode(value: string | undefined): StorageMode | undefined {
	if (value === "jsonl") return "jsonl";
	if (value === "db" || value === "database") return "db";
	return undefined;
}

function validationError(request: Readonly<StorageCommandRequest>): string | undefined {
	if (SOURCE_ONLY_ACTIONS[request.action] && !request.source) {
		return `${request.action} requires an explicit --source`;
	}
	if (DESTINATION_ONLY_ACTIONS[request.action] && !request.destination) {
		return `${request.action} requires an explicit --destination`;
	}
	if (SOURCE_AND_DESTINATION_ACTIONS[request.action]) {
		if (!request.source) return `${request.action} requires an explicit --source`;
		if (!request.destination) return `${request.action} requires an explicit --destination`;
	}
	if (request.action === "recover" && !request.allowedRoot) {
		return "recover requires an explicit --allowed-root";
	}
	if (request.action === "mode" && !request.requestedMode) {
		return "mode requires `jsonl` or `db`";
	}
	if (request.action === "status" && (request.source || request.destination)) {
		return "status does not accept --source or --destination";
	}
	if (request.cancelAfterCurrentBatch && request.resume) {
		return "--cancel-after-current-batch and --resume are mutually exclusive";
	}
	if ((request.cancelAfterCurrentBatch || request.resume) && !request.jobId) {
		return "--cancel-after-current-batch and --resume require --job-id";
	}
	if (request.dryRun !== true && WRITING_ACTIONS[request.action]) {
		if (request.pathsConfirmed !== true) {
			return `${request.action} requires explicit path confirmation`;
		}
		if (request.secondConfirmation !== true) {
			return `${request.action} requires a second confirmation after reviewing its dry-run summary`;
		}
		if (FRESH_BACKUP_ACTIONS[request.action] && !request.backupReceipt) {
			return `${request.action} requires a verified fresh backup receipt`;
		}
	}
	if (request.dryRun !== true && MUTATING_REPOSITORY_ACTIONS[request.action]) {
		if (!request.fencePath || request.expectedGeneration === undefined || !request.expectedNonce) {
			return `${request.action} requires --fence, --expected-generation, and --expected-nonce for fenced repository mutation`;
		}
	}
	return undefined;
}

function baseReport(request: Readonly<StorageCommandRequest>): Omit<StorageReport, "outcome" | "message"> {
	return {
		schema: STORAGE_REPORT_SCHEMA,
		action: request.action,
		dryRun: request.dryRun === true,
		jobId: request.jobId,
		source: request.source,
		destination: request.destination,
		allowedRoot: request.allowedRoot,
		journalPath: request.journalPath,
		generationId: request.generationId,
		fencePath: request.fencePath,
		allBranches: request.allBranches === true,
		resume: request.resume === true,
		cancelAfterCurrentBatch: request.cancelAfterCurrentBatch === true,
		requestedMode: request.requestedMode,
		expectedGeneration: request.expectedGeneration,
		expectedNonce: request.expectedNonce,
		pathsConfirmed: request.pathsConfirmed,
		secondConfirmation: request.secondConfirmation,
		backupReceipt: request.backupReceipt,
	};
}

function emitReport(
	report: StorageReport,
	request: Readonly<StorageCommandRequest>,
	deps: Readonly<StorageCommandDependencies>,
): StorageReport {
	deps.writeStdout(request.machine ? formatStorageReportJson(report) : formatStorageReportText(report));
	return report;
}

/**
 * Execute one storage control command. Only actions in {@link MIGRATION_ACTIONS}
 * can obtain a migration controller and therefore touch JSONL session paths.
 */
export async function runStorageCommand(
	request: Readonly<StorageCommandRequest>,
	dependencies: Partial<StorageCommandDependencies> = {},
): Promise<StorageReport> {
	const deps: StorageCommandDependencies = { ...defaultStorageCommandDependencies, ...dependencies };
	const invalid = validationError(request);
	if (invalid) {
		return emitReport({ ...baseReport(request), outcome: "rejected", message: invalid }, request, deps);
	}

	try {
		const status = await deps.getStatus(request);
		if (request.action === "status") {
			return emitReport(
				{
					...baseReport(request),
					outcome: "ok",
					message: `Active storage backend: ${status.activeMode === "db" ? "Database" : "JSONL"}`,
					status,
				},
				request,
				deps,
			);
		}

		if (request.action === "mode") {
			if (
				request.requestedMode === "db" &&
				(!status.databaseCapability.enabled || !status.databaseCapability.verifiedReceipt)
			) {
				const failure = status.databaseCapability.failure?.message ?? DISABLED_DATABASE_REASON;
				return emitReport(
					{ ...baseReport(request), outcome: "rejected", message: failure, status },
					request,
					deps,
				);
			}
			const result = dependencies.previewModeTransition
				? await deps.previewModeTransition(request, status)
				: await deps.previewModeTransition(request, status, await deps.loadTransitionSteps(request, status));
			const currentStatus = await deps.getStatus(request);
			return emitReport(
				{
					...baseReport(request),
					outcome: "preview",
					message: result.message,
					counts: result.counts,
					details: { ...result.details, configurationMutated: false },
					status: currentStatus,
				},
				request,
				deps,
			);
		}

		if (
			request.expectedGeneration !== undefined &&
			request.expectedGeneration !== status.configurationGeneration
		) {
			return emitReport(
				{
					...baseReport(request),
					outcome: "rejected",
					message: `Stale storage generation: expected ${request.expectedGeneration}, current ${status.configurationGeneration}`,
					status,
				},
				request,
				deps,
			);
		}
		if (
			request.expectedNonce !== undefined &&
			request.expectedNonce !== status.generationToken?.nonce
		) {
			return emitReport(
				{
					...baseReport(request),
					outcome: "rejected",
					message: "Stale storage generation nonce",
					status,
				},
				request,
				deps,
			);
		}


		if (!MIGRATION_ACTIONS[request.action]) {
			return emitReport(
				{ ...baseReport(request), outcome: "rejected", message: `Unsupported storage action: ${request.action}` },
				request,
				deps,
			);
		}

		const controller = await deps.loadMigrationController(request);
		const preview = await controller.preview({ ...request, dryRun: true });
		if (request.action === "adopt") {
			return emitReport(
				{
					...baseReport(request),
					outcome: "preview",
					message: preview.message,
					counts: preview.counts,
					details: { ...preview.details, configurationMutated: false, executionEnabled: false },
				},
				request,
				deps,
			);
		}
		if (request.dryRun) {
			return emitReport(
				{
					...baseReport(request),
					outcome: "preview",
					message: preview.message,
					counts: preview.counts,
					details: preview.details,
				},
				request,
				deps,
			);
		}
		if (FRESH_BACKUP_ACTIONS[request.action]) {
			const verifiedReceipt = preview.details?.backupReceipt ?? preview.details?.manifestSha256;
			if (typeof verifiedReceipt !== "string" || verifiedReceipt !== request.backupReceipt) {
				throw new StorageCommandRejectedError(
					`Fresh backup verification failed: expected ${request.backupReceipt}, preview verified ${String(verifiedReceipt)}`,
				);
			}
		}
		const result = await controller.execute(request);
		return emitReport(
			{
				...baseReport(request),
				outcome: "ok",
				message: result.message,
				counts: result.counts,
				details: { ...result.details, dryRunSummary: preview.message },
			},
			request,
			deps,
		);
	} catch (error) {
		const rejected = error instanceof StorageCommandRejectedError;
		return emitReport(
			{
				...baseReport(request),
				outcome: rejected ? "rejected" : "failed",
				message: error instanceof Error ? error.message : String(error),
			},
			request,
			deps,
		);
	}
}
