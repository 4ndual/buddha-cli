import type {
	StorageJobState,
	StorageMode,
	StorageTransferCounts,
	StorageTransferPreview,
	StorageTransferReport,
} from "../contracts";

export const STORAGE_ACTIONS = [
	"inventory",
	"normalize",
	"import",
	"export",
	"sync",
	"verify",
	"backup",
	"recover",
	"mode",
] as const;

export type StorageAction = (typeof STORAGE_ACTIONS)[number];

export type StorageReportFormat = "json" | "jsonl";

export interface StorageControlRequest {
	action: StorageAction;
	dryRun: boolean;
	allBranches: boolean;
	source?: string;
	destination?: string;
	jobId?: string;
	reportPath?: string;
	format: StorageReportFormat;
	targetMode?: StorageMode;
}

export interface StorageBackendCapability {
	available: boolean;
	label: string;
	blocker?: {
		code: string;
		message: string;
		evidence?: string;
	};
}

export interface StorageActivationGates {
	native: boolean;
	verifiedTransfer: boolean;
	rollbackExport: boolean;
}

export interface VerifiedTransferSummary {
	completedAt: string;
	direction: "jsonl-to-db" | "db-to-jsonl" | "synchronize";
	reportId: string;
	sourceHead?: string;
	destinationHead?: string;
}

export interface PathExtensionLimitation {
	extensionId: string;
	detail: string;
	choices: ReadonlyArray<{
		kind: "export" | "jsonl";
		label: string;
	}>;
}
export interface StorageActiveJob {
	jobId: string;
	state: StorageJobState;
	direction: "jsonl-to-db" | "db-to-jsonl" | "synchronize";
}

export interface StorageControlStatus {
	mode: StorageMode;
	activeBackend: string;
	capabilities: {
		jsonl: StorageBackendCapability;
		database: StorageBackendCapability;
	};
	activation: StorageActivationGates;
	lastVerifiedTransfer?: VerifiedTransferSummary;
	activeJob?: StorageActiveJob;
	pathExtensions: readonly PathExtensionLimitation[];
	freshnessNotice: string;
}

export type StoragePreviewCounts = Pick<
	StorageTransferCounts,
	"newVersions" | "extensions" | "siblingForks" | "duplicates" | "quarantined"
>;

export interface StorageControlResult {
	outcome: "preview" | "completed" | "blocked" | "cancel-requested" | "resumed" | "failed";
	message: string;
	status: StorageControlStatus;
	preview?: StorageTransferPreview;
	transfer?: StorageTransferReport;
	job?: StorageActiveJob;
	blocker?: StorageBackendCapability["blocker"];
}

export interface StorageControlService {
	getStatus(signal?: AbortSignal): Promise<StorageControlStatus>;
	preview(request: StorageControlRequest, signal?: AbortSignal): Promise<StorageControlResult>;
	execute(request: StorageControlRequest, signal?: AbortSignal): Promise<StorageControlResult>;
	cancelAfterCurrentBatch(jobId: string, signal?: AbortSignal): Promise<StorageControlResult>;
	resume(jobId: string, signal?: AbortSignal): Promise<StorageControlResult>;
}

export interface StorageReportEnvelope {
	schemaVersion: "omp.storage.control.v1";
	generatedAt: string;
	request: StorageControlRequest;
	result: StorageControlResult;
}

export interface StorageReportSink {
	writeStdout(serialized: string): void;
	writeReport(path: string, serialized: string): Promise<void>;
}
