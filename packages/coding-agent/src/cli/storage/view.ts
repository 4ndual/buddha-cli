import { STORAGE_PANEL_ACTIONS, type StoragePanelActionDefinition } from "./actions";
import type { StorageControlModel } from "./model";
import type { StorageReport } from "./report";

export type StoragePanelStage =
	| "menu"
	| "source"
	| "destination"
	| "confirm-paths"
	| "backup-receipt"
	| "second-confirmation"
	| "running"
	| "result";

export interface StoragePanelViewState {
	stage: StoragePanelStage;
	selectedIndex: number;
	selectedAction?: StoragePanelActionDefinition;
	dryRun: boolean;
	input: string;
	source?: string;
	destination?: string;
	backupReceipt?: string;
	preview?: StorageReport;
	result?: StorageReport;
	message?: string;
}

function truncateLine(line: string, width: number): string {
	const characters = Array.from(line);
	if (characters.length <= width) return line;
	if (width <= 1) return characters.slice(0, width).join("");
	return `${characters.slice(0, width - 1).join("")}…`;
}

function metric(value: number | undefined): string {
	return value === undefined ? "unknown" : value.toLocaleString("en-US");
}

function bytes(value: number | undefined): string {
	if (value === undefined) return "unknown";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function backendLines(label: string, backend: StorageControlModel["backends"]["database"]): string[] {
	return [
		`${label.padEnd(8)} path ${backend.path ?? "not configured"}`,
		`${"".padEnd(8)} engine ${backend.engine} · schema ${backend.schemaVersion ?? "unknown"}`,
		`${"".padEnd(8)} sessions ${metric(backend.counts.sessions)} · origins ${metric(backend.counts.origins)} · branches ${metric(backend.counts.branches)} · versions ${metric(backend.counts.versions)}`,
		`${"".padEnd(8)} events ${metric(backend.counts.events)} · payloads ${metric(backend.counts.payloads)} · size ${bytes(backend.sizeBytes)} · WAL ${bytes(backend.walBytes)}`,
		`${"".padEnd(8)} health ${backend.health.state}: ${backend.health.message}`,
	];
}

function promptLines(state: StoragePanelViewState): string[] {
	switch (state.stage) {
		case "source":
			return ["", `Source path: ${state.input}`, "Enter accepts · Esc cancels"];
		case "destination":
			return ["", `Destination path: ${state.input}`, "Enter accepts · Esc cancels"];
		case "confirm-paths":
			return [
				"",
				`Source: ${state.source ?? "not required"}`,
				`Destination: ${state.destination ?? "not required"}`,
				"Type CONFIRM PATHS to run the dry-run preflight:",
				state.input,
			];
		case "backup-receipt":
			return [
				"",
				state.preview?.message ?? "Dry-run complete",
				"Paste the fresh verified backup receipt (Esc cancels):",
				state.input,
			];
		case "second-confirmation":
			return [
				"",
				state.preview?.message ?? "Dry-run complete",
				"Type APPLY as the second confirmation. Active-mode cutover is never performed:",
				state.input,
			];
		case "running":
			return ["", "Running explicit storage operation…"];
		case "result": {
			const report = state.result ?? state.preview;
			return [
				"",
				report ? `${report.outcome.toUpperCase()}: ${report.message}` : (state.message ?? "No result"),
				"Enter or Esc returns to controls",
			];
		}
		default:
			return [];
	}
}

/** Pure rendering seam used by the real TUI and focused view tests. */
export function renderStoragePanel(
	status: Readonly<StorageControlModel>,
	state: Readonly<StoragePanelViewState>,
	width: number,
	height = Number.POSITIVE_INFINITY,
): readonly string[] {
	const mode = status.activeMode === "db" ? "Database" : "JSONL";
	const defaultMode = status.defaultMode === "db" ? "Database" : "JSONL";
	const lines = [
		"OMP Storage",
		`Active ${mode} · default ${defaultMode} · generation ${status.configurationGeneration}`,
		"Mode commit/cutover: UNAVAILABLE on this experimental branch",
		"",
		...backendLines("JSONL", status.backends.jsonl),
		...backendLines("Database", status.backends.database),
		"",
		`Quarantine ${status.quarantine.total} · last verified transfer ${status.lastVerifiedTransfer?.jobId ?? "none"}`,
		"",
	];
	if (state.stage === "menu") {
		const visibleCount = Number.isFinite(height)
			? Math.max(1, Math.min(STORAGE_PANEL_ACTIONS.length, Math.floor(height) - lines.length - 2))
			: STORAGE_PANEL_ACTIONS.length;
		const start = Math.max(
			0,
			Math.min(
				STORAGE_PANEL_ACTIONS.length - visibleCount,
				state.selectedIndex - Math.floor(visibleCount / 2),
			),
		);
		for (let index = start; index < start + visibleCount; index += 1) {
			const action = STORAGE_PANEL_ACTIONS[index];
			const marker = index === state.selectedIndex ? ">" : " ";
			const suffix = action.previewOnly ? " [preview only]" : "";
			lines.push(`${marker} ${action.label}${suffix} — ${action.description}`);
		}
		lines.push("", `d toggle dry-run (${state.dryRun ? "ON" : "OFF"}) · Enter select · q/Esc quit`);
	}
	lines.push(...promptLines(state));
	if (state.message && state.stage !== "result") lines.push("", state.message);
	return lines.map(line => truncateLine(line, Math.max(1, width)));
}
