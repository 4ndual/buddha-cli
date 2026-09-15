import { type Component, matchesKey, ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import {
	STORAGE_PANEL_ACTIONS,
	type StoragePanelActionDefinition,
} from "./actions";
import type { StorageControlModel, StorageMode } from "./model";
import { defaultStorageCommandDependencies, runStorageCommand, type StorageCommandDependencies, type StorageCommandRequest } from "./storage-cli";
import { renderStoragePanel, type StoragePanelViewState } from "./view";

export interface StoragePanelOptions {
	source?: string;
	destination?: string;
	allowedRoot?: string;
	fencePath?: string;
	journalPath?: string;
	generationId?: string;
	jobId?: string;
	allBranches?: boolean;
	commandDependencies?: Partial<StorageCommandDependencies>;
}

export interface StoragePanelHost {
	requestRender(): void;
	readonly rows: number;
}

export class StoragePanelComponent implements Component {
	readonly #done = Promise.withResolvers<void>();
	readonly #host: StoragePanelHost;
	readonly #options: StoragePanelOptions;
	readonly #dependencies: StorageCommandDependencies;
	#status: StorageControlModel;
	#busy = false;
	#pending: Promise<void> = Promise.resolve();
	#state: StoragePanelViewState = {
		stage: "menu",
		selectedIndex: 0,
		dryRun: true,
		input: "",
	};

	constructor(host: StoragePanelHost, status: StorageControlModel, options: StoragePanelOptions = {}) {
		this.#host = host;
		this.#status = status;
		this.#options = options;
		this.#dependencies = {
			...defaultStorageCommandDependencies,
			...options.commandDependencies,
			writeStdout() {},
		};
	}

	get state(): Readonly<StoragePanelViewState> {
		return this.#state;
	}

	get status(): Readonly<StorageControlModel> {
		return this.#status;
	}

	run(): Promise<void> {
		return this.#done.promise;
	}
	waitForIdle(): Promise<void> {
		return this.#pending;
	}


	render(width: number): readonly string[] {
		return renderStoragePanel(this.#status, this.#state, width, this.#host.rows);
	}

	handleInput(data: string): void {
		if (this.#busy) return;
		if (this.#state.stage === "menu") {
			this.#handleMenuInput(data);
			return;
		}
		if (this.#state.stage === "result") {
			if (matchesKey(data, "enter") || matchesKey(data, "escape")) this.#returnToMenu();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#returnToMenu();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.#state = { ...this.#state, input: this.#state.input.slice(0, -1) };
			this.#host.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.#pending = this.#acceptInput();
			return;
		}
		if (data.length === 1 && data >= " " && data !== "\u007f") {
			this.#state = { ...this.#state, input: this.#state.input + data };
			this.#host.requestRender();
		}
	}

	#handleMenuInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.#done.resolve();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.#state = {
				...this.#state,
				selectedIndex: (this.#state.selectedIndex - 1 + STORAGE_PANEL_ACTIONS.length) % STORAGE_PANEL_ACTIONS.length,
			};
			this.#host.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#state = {
				...this.#state,
				selectedIndex: (this.#state.selectedIndex + 1) % STORAGE_PANEL_ACTIONS.length,
			};
			this.#host.requestRender();
			return;
		}
		if (data === "d") {
			this.#state = { ...this.#state, dryRun: !this.#state.dryRun };
			this.#host.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.#pending = this.#selectAction(STORAGE_PANEL_ACTIONS[this.#state.selectedIndex]);
		}
	}

	async #selectAction(action: StoragePanelActionDefinition): Promise<void> {
		if (action.id === "status") {
			await this.#refreshStatus();
			return;
		}
		const source = this.#options.source;
		const destination = this.#options.destination;
		this.#state = {
			...this.#state,
			selectedAction: action,
			source,
			destination,
			input: action.requiresSource ? (source ?? "") : action.requiresDestination ? (destination ?? "") : "",
			stage: action.requiresSource ? "source" : action.requiresDestination ? "destination" : "confirm-paths",
			message: undefined,
			preview: undefined,
			result: undefined,
		};
		this.#host.requestRender();
	}

	async #acceptInput(): Promise<void> {
		const value = this.#state.input.trim();
		switch (this.#state.stage) {
			case "source":
				if (!value) return this.#showMessage("An explicit source path or repository selector is required");
				this.#state = {
					...this.#state,
					source: value,
					stage: this.#state.selectedAction?.requiresDestination ? "destination" : "confirm-paths",
					input: this.#state.selectedAction?.requiresDestination ? (this.#state.destination ?? "") : "",
					message: undefined,
				};
				break;
			case "destination":
				if (!value) return this.#showMessage("An explicit destination path or repository selector is required");
				this.#state = { ...this.#state, destination: value, stage: "confirm-paths", input: "", message: undefined };
				break;
			case "confirm-paths":
				if (value !== "CONFIRM PATHS") return this.#showMessage("Type CONFIRM PATHS exactly to continue");
				await this.#runPreview();
				return;
			case "backup-receipt":
				if (!value) return this.#showMessage("A fresh verified backup receipt is required");
				this.#state = {
					...this.#state,
					backupReceipt: value,
					stage: "second-confirmation",
					input: "",
					message: undefined,
				};
				break;
			case "second-confirmation":
				if (value !== "APPLY") return this.#showMessage("Type APPLY exactly after reviewing the dry-run summary");
				await this.#runExecution();
				return;
		}
		this.#host.requestRender();
	}

	#request(dryRun: boolean): StorageCommandRequest {
		const action = this.#state.selectedAction;
		if (!action) throw new Error("No storage action is selected");
		const targetMode: StorageMode = this.#status.activeMode === "db" ? "jsonl" : "db";
		return {
			action: action.action,
			source: this.#state.source,
			destination: this.#state.destination,
			allowedRoot: this.#options.allowedRoot,
			fencePath: this.#options.fencePath,
			journalPath: this.#options.journalPath,
			generationId: this.#options.generationId,
			jobId: this.#options.jobId,
			allBranches: this.#options.allBranches,
			dryRun,
			requestedMode: action.action === "mode" ? targetMode : undefined,
			expectedGeneration: this.#status.generationToken?.generation,
			expectedNonce: this.#status.generationToken?.nonce,
			pathsConfirmed: !dryRun,
			secondConfirmation: !dryRun,
			backupReceipt: dryRun ? undefined : this.#state.backupReceipt,
		};
	}

	async #runPreview(): Promise<void> {
		this.#busy = true;
		this.#state = { ...this.#state, stage: "running", input: "", message: undefined };
		this.#host.requestRender();
		try {
			const report = await runStorageCommand(this.#request(true), this.#dependencies);
			this.#state = { ...this.#state, preview: report };
			if (report.outcome === "failed" || report.outcome === "rejected" || this.#state.dryRun || this.#state.selectedAction?.previewOnly) {
				this.#state = { ...this.#state, stage: "result", result: report };
			} else if (this.#state.selectedAction?.requiresFreshBackup) {
				this.#state = { ...this.#state, stage: "backup-receipt", input: "" };
			} else {
				this.#state = { ...this.#state, stage: "second-confirmation", input: "" };
			}
		} catch (error) {
			this.#state = {
				...this.#state,
				stage: "result",
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.#busy = false;
			this.#host.requestRender();
		}
	}

	async #runExecution(): Promise<void> {
		const backupReceipt = this.#state.selectedAction?.requiresFreshBackup ? this.#state.backupReceipt : undefined;
		this.#busy = true;
		this.#state = { ...this.#state, stage: "running", input: "", message: undefined };
		this.#host.requestRender();
		try {
			const request = this.#request(false);
			request.backupReceipt = backupReceipt;
			const report = await runStorageCommand(request, this.#dependencies);
			this.#state = { ...this.#state, stage: "result", result: report };
			await this.#refreshStatus(false);
		} catch (error) {
			this.#state = {
				...this.#state,
				stage: "result",
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.#busy = false;
			this.#host.requestRender();
		}
	}

	async #refreshStatus(returnToMenu = true): Promise<void> {
		this.#busy = true;
		try {
			this.#status = await this.#dependencies.getStatus({ action: "status", fencePath: this.#options.fencePath });
			if (returnToMenu) this.#returnToMenu();
		} catch (error) {
			this.#state = {
				...this.#state,
				stage: "result",
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.#busy = false;
			this.#host.requestRender();
		}
	}

	#showMessage(message: string): void {
		this.#state = { ...this.#state, message };
		this.#host.requestRender();
	}

	#returnToMenu(): void {
		this.#state = {
			stage: "menu",
			selectedIndex: this.#state.selectedIndex,
			dryRun: this.#state.dryRun,
			input: "",
		};
		this.#host.requestRender();
	}

}

export async function runStoragePanel(options: StoragePanelOptions = {}): Promise<void> {
	const dependencies: StorageCommandDependencies = {
		...defaultStorageCommandDependencies,
		...options.commandDependencies,
	};
	const status = await dependencies.getStatus({ action: "status", fencePath: options.fencePath });
	const ui = new TUI(new ProcessTerminal());
	const component = new StoragePanelComponent(
		{ requestRender: () => ui.requestRender(), get rows() { return ui.terminal.rows; } },
		status,
		options,
	);
	ui.addChild(component);
	ui.setFocus(component);
	ui.start();
	try {
		await component.run();
	} finally {
		ui.stop();
	}
}
