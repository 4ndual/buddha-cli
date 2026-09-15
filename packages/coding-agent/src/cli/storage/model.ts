export type StorageMode = "jsonl" | "db";

export type StorageAction =
	| "inventory"
	| "create"
	| "open"
	| "copy-as-is"
	| "normalize"
	| "normalize-copy"
	| "import"
	| "export"
	| "sync"
	| "verify"
	| "repair"
	| "backup"
	| "rollback"
	| "recover"
	| "migrate"
	| "adopt"
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
export type StorageHealth = "healthy" | "degraded" | "unavailable" | "unknown";

export interface StorageBackendStatus {
	path?: string;
	engine: string;
	schemaVersion?: string;
	counts: Readonly<{
		sessions: number;
		origins: number;
		branches: number;
		versions: number;
		events: number;
		payloads: number;
	}>;
	sizeBytes?: number;
	walBytes?: number;
	health: {
		state: StorageHealth;
		message: string;
		checkedAt?: string;
	};
}


/**
 * Headless view model shared by the CLI and interactive Storage panel. It
 * contains only control-plane state: rendering it must not initialize the
 * database driver or inspect JSONL session files.
 */
export interface StorageControlModel {
	defaultMode: StorageMode;
	activeMode: StorageMode;
	/** Persisted fencing generation required by every repository mutation. */
	configurationGeneration: number;
	generationToken?: {
		generation: number;
		nonce: string;
	};
	preparedTransition?: {
		state: "preparing" | "verified" | "aborted";
		targetMode: StorageMode;
		transitionId: string;
		verificationReceipt?: string;
	};
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
	backends: {
		jsonl: StorageBackendStatus;
		database: StorageBackendStatus;
	};
}

export const DISABLED_DATABASE_REASON =
	"Database mode is disabled until the native embedded Turso capability gates have a verified receipt";

/** Safe startup state used before a capability provider is installed. */
export function createDisabledStorageControlModel(): StorageControlModel {
	return {
		defaultMode: "jsonl",
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
		backends: {
			jsonl: {
				engine: "OMP JSONL",
				counts: { sessions: 0, origins: 0, branches: 0, versions: 0, events: 0, payloads: 0 },
				health: { state: "unknown", message: "Not inspected; status never scans session JSONL" },
			},
			database: {
				engine: "Turso (native embedded)",
				counts: { sessions: 0, origins: 0, branches: 0, versions: 0, events: 0, payloads: 0 },
				health: { state: "unavailable", message: DISABLED_DATABASE_REASON },
			},
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
