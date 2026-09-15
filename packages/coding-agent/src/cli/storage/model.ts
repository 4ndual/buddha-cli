export type StorageMode = "jsonl" | "db";

export type StorageAction =
	| "inventory"
	| "normalize"
	| "import"
	| "export"
	| "sync"
	| "verify"
	| "backup"
	| "recover"
	| "mode"
	| "status";

export type StorageJobState =
	| "planned"
	| "running"
	| "cancel-pending"
	| "interrupted"
	| "completed"
	| "failed";

export interface StorageModeOption {
	mode: StorageMode;
	label: "JSONL" | "Database";
	enabled: boolean;
	reason?: string;
}

export interface VerifiedTransferSummary {
	jobId: string;
	direction: "jsonl-to-db" | "db-to-jsonl" | "bidirectional";
	verifiedAt: string;
	source: string;
	destination: string;
	versionCount: number;
	branchCount: number;
	manifestHash: string;
}

export interface DatabaseCapabilityStatus {
	enabled: boolean;
	verifiedReceipt?: string;
	failure?: {
		code: string;
		message: string;
		evidencePath?: string;
	};
}

export interface StorageQuarantineCounts {
	total: number;
	malformed: number;
	unsupported: number;
	missingPayload: number;
	unresolvedIdentity: number;
}

export interface StorageRecoveryAction {
	id: string;
	label: string;
	description: string;
	requiresSource: boolean;
	requiresDestination: boolean;
	destructive: false;
}

/**
 * Headless view model shared by the CLI and a future Storage panel. It contains
 * only control-plane state: rendering it must not initialize the database
 * driver or inspect JSONL session files.
 */
export interface StorageControlModel {
	activeMode: StorageMode;
	/** Persisted fencing generation required by every repository mutation. */
	configurationGeneration: number;
	modes: readonly StorageModeOption[];
	lastVerifiedTransfer?: VerifiedTransferSummary;
	databaseCapability: DatabaseCapabilityStatus;
	quarantine: StorageQuarantineCounts;
	recoveryActions: readonly StorageRecoveryAction[];
	activeJob?: {
		jobId: string;
		action: Exclude<StorageAction, "mode" | "status">;
		state: StorageJobState;
		completedItems: number;
		totalItems?: number;
		cancelAfterCurrentBatch: boolean;
	};
}

export const DISABLED_DATABASE_REASON =
	"Database mode is disabled until the native embedded Turso capability gates have a verified receipt";

/** Safe startup state used before a capability provider is installed. */
export function createDisabledStorageControlModel(): StorageControlModel {
	return {
		activeMode: "jsonl",
		configurationGeneration: 0,
		modes: [
			{ mode: "jsonl", label: "JSONL", enabled: true },
			{ mode: "db", label: "Database", enabled: false, reason: DISABLED_DATABASE_REASON },
		],
		databaseCapability: {
			enabled: false,
			failure: {
				code: "capability-not-verified",
				message: DISABLED_DATABASE_REASON,
			},
		},
		quarantine: {
			total: 0,
			malformed: 0,
			unsupported: 0,
			missingPayload: 0,
			unresolvedIdentity: 0,
		},
		recoveryActions: [
			{
				id: "verify-jsonl",
				label: "Verify JSONL",
				description: "Validate an explicitly selected JSONL source without loading the database driver",
				requiresSource: true,
				requiresDestination: true,
				destructive: false,
			},
			{
				id: "recover-jsonl",
				label: "Recover to JSONL",
				description: "Recover a verified backup into an explicit destination; never changes the active mode",
				requiresSource: true,
				requiresDestination: true,
				destructive: false,
			},
		],
	};
}
