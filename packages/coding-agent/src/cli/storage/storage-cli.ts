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
	normalize: true,
	import: true,
	export: true,
	sync: true,
	verify: true,
	backup: true,
	recover: true,
	mode: true,
	status: true,
};

const MIGRATION_ACTIONS: Partial<Record<StorageAction, true>> = {
	inventory: true,
	normalize: true,
	import: true,
	export: true,
	sync: true,
	verify: true,
	backup: true,
	recover: true,
};
const MUTATING_REPOSITORY_ACTIONS: Partial<Record<StorageAction, true>> = {
	import: true,
	sync: true,
	recover: true,
};


const SOURCE_ONLY_ACTIONS: Partial<Record<StorageAction, true>> = { inventory: true };
const SOURCE_AND_DESTINATION_ACTIONS: Partial<Record<StorageAction, true>> = {
	normalize: true,
	import: true,
	export: true,
	sync: true,
	verify: true,
	backup: true,
	recover: true,
};

export interface StorageCommandRequest {
	action: StorageAction;
	source?: string;
	destination?: string;
	dryRun?: boolean;
	allBranches?: boolean;
	jobId?: string;
	cancelAfterCurrentBatch?: boolean;
	resume?: boolean;
	requestedMode?: StorageMode;
	expectedGeneration?: number;
	machine?: boolean;
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
	getStatus(): Promise<StorageControlModel>;
	loadMigrationController(request: Readonly<StorageCommandRequest>): Promise<StorageMigrationController>;
	previewModeTransition(
		request: Readonly<StorageCommandRequest>,
		status: Readonly<StorageControlModel>,
	): Promise<StorageOperationResult>;
	writeStdout(text: string): void;
}

export class StorageCommandRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageCommandRejectedError";
	}
}

const disabledMigrationController: StorageMigrationController = {
	async preview(request) {
		return {
			message: `${request.action} preview created; execution remains disabled until a repository migration controller is installed`,
			details: { executionEnabled: false },
		};
	},
	async execute() {
		throw new StorageCommandRejectedError(
			"Storage migration execution is disabled until the repository migration controller is installed",
		);
	},
};

export const defaultStorageCommandDependencies: StorageCommandDependencies = {
	async getStatus() {
		return createDisabledStorageControlModel();
	},
	async loadMigrationController() {
		return disabledMigrationController;
	},
	async previewModeTransition(request, status) {
		const requested = request.requestedMode;
		return {
			message: `Prepared a ${status.activeMode} → ${requested} transition preview; active configuration was not changed`,
			details: { configurationMutated: false, from: status.activeMode, to: requested },
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
	if (SOURCE_AND_DESTINATION_ACTIONS[request.action]) {
		if (!request.source) return `${request.action} requires an explicit --source`;
		if (!request.destination) return `${request.action} requires an explicit --destination`;
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
	if (
		request.dryRun !== true &&
		(MUTATING_REPOSITORY_ACTIONS[request.action] || request.cancelAfterCurrentBatch) &&
		request.expectedGeneration === undefined
	) {
		return `${request.action} requires --expected-generation for fenced repository mutation`;
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
		allBranches: request.allBranches === true,
		resume: request.resume === true,
		cancelAfterCurrentBatch: request.cancelAfterCurrentBatch === true,
		requestedMode: request.requestedMode,
		expectedGeneration: request.expectedGeneration,
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
		const status = await deps.getStatus();
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
			const result = await deps.previewModeTransition(request, status);
			return emitReport(
				{
					...baseReport(request),
					outcome: "preview",
					message: result.message,
					counts: result.counts,
					details: { ...result.details, configurationMutated: false },
					status,
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

		if (!MIGRATION_ACTIONS[request.action]) {
			return emitReport(
				{ ...baseReport(request), outcome: "rejected", message: `Unsupported storage action: ${request.action}` },
				request,
				deps,
			);
		}

		const controller = await deps.loadMigrationController(request);
		const result = request.dryRun ? await controller.preview(request) : await controller.execute(request);
		return emitReport(
			{
				...baseReport(request),
				outcome: request.dryRun ? "preview" : "ok",
				message: result.message,
				counts: result.counts,
				details: result.details,
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
