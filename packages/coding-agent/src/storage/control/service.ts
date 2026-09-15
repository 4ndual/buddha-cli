import type { StorageMode } from "../contracts";
import type {
	StorageBackendCapability,
	StorageControlRequest,
	StorageControlResult,
	StorageControlService,
	StorageControlStatus,
} from "./types";

const NATIVE_BLOCKER: NonNullable<StorageBackendCapability["blocker"]> = {
	code: "wcdb-native-unverified",
	message: "WCDB native support has not passed the pinned build/runtime capability gate. Database activation is disabled.",
	evidence: "Run `omp storage verify --report <path>` after the native bridge and recovery gates pass.",
};

export function modeActivationBlocker(
	status: StorageControlStatus,
	targetMode: StorageMode,
): StorageBackendCapability["blocker"] | undefined {
	if (targetMode === "jsonl") {
		return status.capabilities.jsonl.available
			? undefined
			: (status.capabilities.jsonl.blocker ?? {
					code: "jsonl-unavailable",
					message: "JSONL storage is unavailable. Keep the current mode selected and repair JSONL access first.",
				});
	}
	if (!status.capabilities.database.available || !status.activation.native) {
		return status.capabilities.database.blocker ?? NATIVE_BLOCKER;
	}
	if (!status.activation.verifiedTransfer) {
		return {
			code: "transfer-unverified",
			message: "Database activation requires a verified transfer whose target head matches the requested source head.",
			evidence: "Preview and run JSONL → DB, then run Verify before selecting Database mode.",
		};
	}
	if (!status.activation.rollbackExport) {
		return {
			code: "rollback-export-unverified",
			message: "Database activation requires a verified DB → JSONL rollback export.",
			evidence: "Export and validate a rollback bundle before selecting Database mode.",
		};
	}
	return undefined;
}

export async function executeStorageControlRequest(
	service: StorageControlService,
	request: StorageControlRequest,
	signal?: AbortSignal,
): Promise<StorageControlResult> {
	if (request.action === "mode" && request.targetMode) {
		const status = await service.getStatus(signal);
		const blocker = modeActivationBlocker(status, request.targetMode);
		if (blocker) {
			return {
				outcome: "blocked",
				message: blocker.message,
				status,
				blocker,
			};
		}
	}
	return request.dryRun ? service.preview(request, signal) : service.execute(request, signal);
}

class DisabledStorageControlService implements StorageControlService {
	readonly #status: StorageControlStatus = {
		mode: "jsonl",
		activeBackend: "OMP JSONL session repository",
		capabilities: {
			jsonl: { available: true, label: "JSONL available" },
			database: { available: false, label: "Database unavailable", blocker: NATIVE_BLOCKER },
		},
		activation: {
			native: false,
			verifiedTransfer: false,
			rollbackExport: false,
		},
		pathExtensions: [],
		freshnessNotice:
			"Modes are independent: there is no fallback, hidden dual write, or background archive scan. An older copy is not guaranteed current.",
	};

	async getStatus(): Promise<StorageControlStatus> {
		return this.#status;
	}

	async preview(_request: StorageControlRequest): Promise<StorageControlResult> {
		return this.#blocked();
	}

	async execute(request: StorageControlRequest): Promise<StorageControlResult> {
		if (request.action === "mode" && request.targetMode === "jsonl") {
			return {
				outcome: "completed",
				message: "JSONL mode remains active. No configuration was changed.",
				status: this.#status,
			};
		}
		return this.#blocked();
	}

	async cancelAfterCurrentBatch(_jobId: string): Promise<StorageControlResult> {
		return this.#blocked();
	}

	async resume(_jobId: string): Promise<StorageControlResult> {
		return this.#blocked();
	}

	#blocked(): StorageControlResult {
		return {
			outcome: "blocked",
			message: NATIVE_BLOCKER.message,
			status: this.#status,
			blocker: NATIVE_BLOCKER,
		};
	}
}

let serviceFactory: () => StorageControlService = () => new DisabledStorageControlService();

export function createStorageControlService(): StorageControlService {
	return serviceFactory();
}

/** Install the runtime-owned control service without coupling controls to filesystem or native modules. */
export function registerStorageControlServiceFactory(factory: () => StorageControlService): () => void {
	const previous = serviceFactory;
	serviceFactory = factory;
	return () => {
		if (serviceFactory === factory) serviceFactory = previous;
	};
}
