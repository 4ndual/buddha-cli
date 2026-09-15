import type { StorageAction, StorageControlModel, StorageMode } from "./model";

export const STORAGE_REPORT_SCHEMA = "omp.storage.report.v1" as const;

export type StorageReportOutcome = "ok" | "preview" | "rejected" | "failed";

export interface StorageReport {
	schema: typeof STORAGE_REPORT_SCHEMA;
	action: StorageAction;
	outcome: StorageReportOutcome;
	dryRun: boolean;
	jobId?: string;
	source?: string;
	destination?: string;
	allowedRoot?: string;
	fencePath?: string;
	allBranches: boolean;
	resume: boolean;
	cancelAfterCurrentBatch: boolean;
	requestedMode?: StorageMode;
	expectedGeneration?: number;
	expectedNonce?: string;
	message: string;
	counts?: Readonly<Record<string, number>>;
	details?: Readonly<Record<string, unknown>>;
	status?: StorageControlModel;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const nested = (value as Record<string, unknown>)[key];
		if (nested !== undefined) result[key] = canonicalize(nested);
	}
	return result;
}

/** Deterministic JSON for scripts, receipts, and snapshot comparisons. */
export function formatStorageReportJson(report: StorageReport): string {
	return `${JSON.stringify(canonicalize(report))}\n`;
}

export function formatStorageReportText(report: StorageReport): string {
	const lines = [`storage ${report.action}: ${report.outcome}`, report.message];
	if (report.jobId) lines.push(`job: ${report.jobId}`);
	if (report.source) lines.push(`source: ${report.source}`);
	if (report.destination) lines.push(`destination: ${report.destination}`);
	if (report.status) {
		const status = report.status;
		lines.push(`active backend: ${status.activeMode === "db" ? "Database" : "JSONL"}`);
		lines.push(`configuration generation: ${status.configurationGeneration}`);
		lines.push(`quarantined: ${status.quarantine.total}`);
		if (status.lastVerifiedTransfer) {
			lines.push(
				`last verified transfer: ${status.lastVerifiedTransfer.jobId} (${status.lastVerifiedTransfer.verifiedAt})`,
			);
		}
		if (status.databaseCapability.failure) {
			lines.push(`database capability: ${status.databaseCapability.failure.message}`);
		}
	}
	return `${lines.join("\n")}\n`;
}
