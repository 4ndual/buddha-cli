import { type SelectItem, SelectList, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import { OverlayPanel } from "../../modes/components/overlay-box";
import type { StorageControlResult, StorageControlStatus } from "./types";

export const STORAGE_PANEL_ACTIONS = [
	"mode-jsonl",
	"mode-db",
	"jsonl-to-db",
	"db-to-jsonl",
	"synchronize",
	"verify",
	"backup",
	"recover",
	"cancel",
	"resume",
] as const;

export type StoragePanelAction = (typeof STORAGE_PANEL_ACTIONS)[number];

const ACTION_ITEMS: SelectItem[] = [
	{ value: "mode-jsonl", label: "Use JSONL mode", description: "Select the independent JSONL repository" },
	{ value: "mode-db", label: "Use Database mode", description: "Requires native, transfer, and rollback gates" },
	{ value: "jsonl-to-db", label: "JSONL → DB", description: "Preview normalized versions before importing" },
	{ value: "db-to-jsonl", label: "DB → JSONL", description: "Export a branch, every fork, or a full archive" },
	{
		value: "synchronize",
		label: "Synchronize both",
		description: "Preview reconciliation; divergent histories remain sibling forks",
	},
	{ value: "verify", label: "Verify", description: "Check graph, payload, manifest, and selected heads" },
	{ value: "backup", label: "Backup", description: "Create a verified backend-native backup" },
	{ value: "recover", label: "Recover", description: "Repair a copy and produce a salvage report" },
	{ value: "cancel", label: "Cancel after current batch", description: "Keep the last committed durable cursor" },
	{ value: "resume", label: "Resume interrupted job", description: "Continue from verified commit receipts" },
];

function safeLine(value: string, width = 120): string {
	return truncateToWidth(replaceTabs(value).replace(/[\r\n]+/g, " "), width);
}

function yesNo(value: boolean): string {
	return value ? theme.fg("success", "ready") : theme.fg("warning", "blocked");
}

function formatStatus(status: StorageControlStatus): string {
	const selectedMode = status.mode === "jsonl" ? "JSONL" : "Database";
	const transfer = status.lastVerifiedTransfer
		? `${status.lastVerifiedTransfer.direction} · ${status.lastVerifiedTransfer.completedAt} · ${status.lastVerifiedTransfer.reportId}`
		: "none";
	const databaseReason = status.capabilities.database.blocker?.message;
	const lines = [
		`${theme.bold("Mode")}  ${selectedMode}    ${theme.bold("Active backend")}  ${safeLine(status.activeBackend, 72)}`,
		`${theme.bold("Capability")}  JSONL ${yesNo(status.capabilities.jsonl.available)} · Database ${yesNo(status.capabilities.database.available)} · Native ${yesNo(status.activation.native)}`,
		`${theme.bold("Activation gates")}  verified transfer ${yesNo(status.activation.verifiedTransfer)} · rollback export ${yesNo(status.activation.rollbackExport)}`,
		`${theme.bold("Last verified transfer")}  ${safeLine(transfer)}`,
	];
	if (databaseReason) lines.push(theme.fg("warning", `Database blocker: ${safeLine(databaseReason)}`));
	if (status.activeJob) {
		lines.push(
			`${theme.bold("Active job")}  ${safeLine(status.activeJob.jobId, 48)} · ${status.activeJob.direction} · ${status.activeJob.state}`,
		);
	}
	lines.push(theme.fg("muted", safeLine(status.freshnessNotice)));
	return lines.join("\n");
}

function formatResult(result: StorageControlResult | undefined): string {
	if (!result) return theme.fg("muted", "Choose a transfer action to preview it before execution.");
	const lines = [
		`${theme.bold(result.outcome.toUpperCase())}  ${safeLine(result.message)}`,
	];
	if (result.preview) {
		const counts = result.preview.counts;
		lines.push(
			`Preview: ${counts.newVersions} versions · ${counts.extensions} extensions · ${counts.siblingForks} sibling forks · ${counts.duplicates} duplicates · ${counts.quarantined} quarantined`,
		);
		if (result.preview.warnings.length > 0) {
			lines.push(theme.fg("warning", `Warnings: ${safeLine(result.preview.warnings.join("; "))}`));
		}
	}
	if (result.blocker?.evidence) lines.push(theme.fg("muted", safeLine(result.blocker.evidence)));
	return lines.join("\n");
}

function formatExtensionLimitations(status: StorageControlStatus): string | undefined {
	if (status.pathExtensions.length === 0) return undefined;
	return status.pathExtensions
		.map(limitation => {
			const choices = limitation.choices.map(choice => choice.label).join(" or ");
			return `${safeLine(limitation.extensionId, 32)}: ${safeLine(limitation.detail, 72)} Choose ${safeLine(choices, 72)}.`;
		})
		.join("\n");
}

export interface StoragePanelCallbacks {
	onAction(action: StoragePanelAction): void;
	onCancel(): void;
}

export class StoragePanelComponent extends OverlayPanel {
	readonly #statusText: Text;
	readonly #resultText: Text;
	readonly #limitationsText: Text;
	readonly #actions: SelectList;

	constructor(status: StorageControlStatus, callbacks: StoragePanelCallbacks) {
		super("Storage");
		this.#statusText = new Text(formatStatus(status), 0, 0);
		this.#resultText = new Text(formatResult(undefined), 0, 0);
		this.#limitationsText = new Text("", 0, 0);
		this.#actions = new SelectList(ACTION_ITEMS, ACTION_ITEMS.length, getSelectListTheme());
		this.#actions.onSelect = item => callbacks.onAction(item.value as StoragePanelAction);
		this.#actions.onCancel = callbacks.onCancel;

		this.addChild(this.#statusText);
		this.addChild(new Spacer(1));
		this.addChild(this.#resultText);
		this.addChild(new Spacer(1));
		this.addChild(this.#limitationsText);
		this.addChild(this.#actions);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  ↑↓ move · Enter preview/run · Esc close"), 0, 0));
		this.update(status);
	}

	update(status: StorageControlStatus, result?: StorageControlResult): void {
		this.#statusText.setText(formatStatus(status));
		this.#resultText.setText(formatResult(result));
		const limitations = formatExtensionLimitations(status);
		this.#limitationsText.setText(limitations ? `${theme.bold("Path-dependent extensions")}\n${limitations}\n` : "");
	}

	setBusy(label: string): void {
		this.#resultText.setText(theme.fg("accent", safeLine(label)));
	}

	handleInput(data: string): void {
		this.#actions.handleInput(data);
	}
}
