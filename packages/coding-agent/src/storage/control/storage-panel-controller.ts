import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import type { InteractiveModeContext } from "../../modes/types";
import { createStorageControlService, executeStorageControlRequest } from "./service";
import { StoragePanelComponent, type StoragePanelAction } from "./storage-panel";
import type {
	StorageAction,
	StorageControlRequest,
	StorageControlResult,
	StorageControlService,
	StorageControlStatus,
} from "./types";

export interface StoragePanelControllerCallbacks {
	onUpdate(status: StorageControlStatus, result?: StorageControlResult): void;
	onBusy(label: string): void;
}

export interface StoragePanelRequestDefaults {
	source?: string;
	destination?: string;
	allBranches?: boolean;
}
interface PreparedTransfer {
	panelAction: "jsonl-to-db" | "db-to-jsonl" | "synchronize";
	request: StorageControlRequest;
	jobId: string;
}

export class StoragePanelController {
	readonly #service: StorageControlService;
	readonly #callbacks: StoragePanelControllerCallbacks;
	readonly #defaults: StoragePanelRequestDefaults;
	#status: StorageControlStatus | undefined;
	#busy = false;
	#preparedTransfer: PreparedTransfer | undefined;

	constructor(
		service: StorageControlService,
		callbacks: StoragePanelControllerCallbacks,
		defaults: StoragePanelRequestDefaults = {},
	) {
		this.#service = service;
		this.#callbacks = callbacks;
		this.#defaults = defaults;
	}

	async initialize(initialStatus?: StorageControlStatus): Promise<StorageControlStatus> {
		const status = initialStatus ?? (await this.#service.getStatus());
		this.#status = status;
		this.#callbacks.onUpdate(status);
		return status;
	}

	async select(action: StoragePanelAction): Promise<StorageControlResult | undefined> {
		if (this.#busy) return undefined;
		this.#busy = true;
		if (action !== "jsonl-to-db" && action !== "db-to-jsonl" && action !== "synchronize") {
			this.#preparedTransfer = undefined;
		}
		this.#callbacks.onBusy(this.#busyLabel(action));
		try {
			const status = this.#status ?? (await this.#service.getStatus());
			this.#status = status;
			let result: StorageControlResult;
			switch (action) {
				case "mode-jsonl":
					result = await executeStorageControlRequest(this.#service, this.#request("mode", false, "jsonl"));
					break;
				case "mode-db":
					result = await executeStorageControlRequest(this.#service, this.#request("mode", false, "db"));
					break;
				case "jsonl-to-db":
					result = await this.#transfer(action, "import");
					break;
				case "db-to-jsonl":
					result = await this.#transfer(action, "export");
					break;
				case "synchronize":
					result = await this.#transfer(action, "sync");
					break;
				case "verify":
					result = await this.#service.execute(this.#request("verify", false));
					break;
				case "backup":
					result = await this.#service.execute(this.#request("backup", false));
					break;
				case "recover":
					result = await this.#service.execute(this.#request("recover", false));
					break;
				case "cancel":
					result = status.activeJob
						? await this.#service.cancelAfterCurrentBatch(status.activeJob.jobId)
						: this.#missingJob(status, "No active transfer job can be cancelled.");
					break;
				case "resume":
					result = status.activeJob
						? await this.#service.resume(status.activeJob.jobId)
						: this.#missingJob(status, "No interrupted transfer job can be resumed.");
					break;
			}
			this.#status = result.status;
			this.#callbacks.onUpdate(result.status, result);
			return result;
		} catch (error) {
			const status = this.#status ?? (await this.#service.getStatus());
			const result: StorageControlResult = {
				outcome: "failed",
				message: error instanceof Error ? error.message : String(error),
				status,
			};
			this.#callbacks.onUpdate(status, result);
			return result;
		} finally {
			this.#busy = false;
		}
	}

	async #transfer(
		panelAction: PreparedTransfer["panelAction"],
		action: Extract<StorageAction, "import" | "export" | "sync">,
	): Promise<StorageControlResult> {
		const prepared = this.#preparedTransfer;
		if (prepared?.panelAction === panelAction) {
			this.#preparedTransfer = undefined;
			return this.#service.execute({ ...prepared.request, dryRun: false, jobId: prepared.jobId });
		}
		const request = this.#request(action, true);
		const result = await this.#service.preview(request);
		if (result.preview) {
			this.#preparedTransfer = { panelAction, request, jobId: result.preview.jobId };
			return {
				...result,
				message: `${result.message} Select this transfer again to commit the previewed job.`,
			};
		}
		this.#preparedTransfer = undefined;
		return result;
	}

	#request(action: StorageAction, dryRun: boolean, targetMode?: "jsonl" | "db"): StorageControlRequest {
		return {
			action,
			dryRun,
			allBranches: this.#defaults.allBranches ?? false,
			source: this.#defaults.source,
			destination: this.#defaults.destination,
			format: "json",
			targetMode,
		};
	}

	#missingJob(status: StorageControlStatus, message: string): StorageControlResult {
		return { outcome: "blocked", message, status };
	}

	#busyLabel(action: StoragePanelAction): string {
		switch (action) {
			case "jsonl-to-db":
			case "db-to-jsonl":
			case "synchronize":
				return "Building transfer preview…";
			case "cancel":
				return "Requesting cancellation after the current batch…";
			case "resume":
				return "Resuming from verified receipts…";
			case "mode-jsonl":
			case "mode-db":
				return "Checking activation gates…";
			default:
				return `Running ${action}…`;
		}
	}
}

export async function openStoragePanel(
	ctx: InteractiveModeContext,
	service: StorageControlService = createStorageControlService(),
): Promise<void> {
	let overlay: OverlayHandle | undefined;
	let panel: StoragePanelComponent | undefined;
	const close = (): void => {
		overlay?.hide();
		const visible = ctx.editorContainer.children[0] ?? ctx.editor;
		ctx.ui.setFocus(visible);
		ctx.ui.requestRender();
	};
	const controller = new StoragePanelController(service, {
		onUpdate(status, result): void {
			panel?.update(status, result);
			ctx.ui.requestRender();
		},
		onBusy(label): void {
			panel?.setBusy(label);
			ctx.ui.requestRender();
		},
	});
	try {
		const status = await service.getStatus();
		panel = new StoragePanelComponent(status, {
			onAction(action): void {
				void controller.select(action);
			},
			onCancel: close,
		});
		overlay = ctx.ui.showOverlay(panel, {
			anchor: "bottom-center",
			width: "90%",
			maxHeight: "90%",
			margin: 1,
		});
		ctx.ui.setFocus(panel);
		ctx.ui.requestRender();
		await controller.initialize(status);
	} catch (error) {
		close();
		ctx.showError(`Storage controls unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
}
