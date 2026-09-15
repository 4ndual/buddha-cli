import type { LogicalBundle, LogicalEvent, LogicalVersion } from "./bundle";
import {
	importLogicalBundle,
	isAncestor,
	planLogicalImport,
	type ImportBundleResult,
	type ImportVersionPlan,
	type LogicalImportTarget,
} from "./import";

export interface LogicalSyncReplica extends LogicalImportTarget {
	readLogicalSnapshot(): Promise<LogicalBundle>;
}

export interface SyncLogicalReplicasOptions {
	jobId: string;
	leftJournalPath: string;
	rightJournalPath: string;
	maxBatchBytes: number;
	shouldCancel?: () => boolean | Promise<boolean>;
}

export interface ReconciliationPreview {
	new_versions: number;
	extensions: number;
	sibling_forks: number;
	historical_versions: number;
	duplicates: number;
	deletions: 0;
}

export interface SyncLogicalReplicasResult {
	leftToRight: ImportBundleResult;
	rightToLeft: ImportBundleResult;
	leftPreview: ReconciliationPreview;
	rightPreview: ReconciliationPreview;
}

/**
 * Reconciles two pinned snapshots. Absence is never interpreted as deletion and
 * timestamps are deliberately absent from every reconciliation decision.
 */
export async function synchronizeLogicalReplicas(
	left: LogicalSyncReplica,
	right: LogicalSyncReplica,
	options: SyncLogicalReplicasOptions,
): Promise<SyncLogicalReplicasResult> {
	const [leftCutoff, rightCutoff] = await Promise.all([left.readLogicalSnapshot(), right.readLogicalSnapshot()]);
	const [leftPlans, rightPlans] = await Promise.all([
		planLogicalImport(leftCutoff, rightCutoff, right),
		planLogicalImport(rightCutoff, leftCutoff, left),
	]);
	const [leftToRight, rightToLeft] = await Promise.all([
		importLogicalBundle(leftCutoff, right, {
			jobId: `${options.jobId}-left-to-right`,
			journalPath: options.leftJournalPath,
			maxBatchBytes: options.maxBatchBytes,
			shouldCancel: options.shouldCancel,
		}),
		importLogicalBundle(rightCutoff, left, {
			jobId: `${options.jobId}-right-to-left`,
			journalPath: options.rightJournalPath,
			maxBatchBytes: options.maxBatchBytes,
			shouldCancel: options.shouldCancel,
		}),
	]);
	return {
		leftToRight,
		rightToLeft,
		leftPreview: summarize(leftPlans),
		rightPreview: summarize(rightPlans),
	};
}

export function compareSemanticVersions(
	left: LogicalVersion,
	right: LogicalVersion,
	events: readonly LogicalEvent[],
): "same" | "left-ancestor" | "right-ancestor" | "divergent" {
	if (left.version_id === right.version_id) return "same";
	const byHash = new Map(events.map((event) => [event.event_hash, event]));
	if (isAncestor(left.head_hash, right.head_hash, byHash)) return "left-ancestor";
	if (isAncestor(right.head_hash, left.head_hash, byHash)) return "right-ancestor";
	return "divergent";
}

function summarize(plans: readonly ImportVersionPlan[]): ReconciliationPreview {
	const preview: ReconciliationPreview = {
		new_versions: 0,
		extensions: 0,
		sibling_forks: 0,
		historical_versions: 0,
		duplicates: 0,
		deletions: 0,
	};
	for (const plan of plans) {
		switch (plan.relationship) {
			case "new":
				preview.new_versions += 1;
				break;
			case "extension":
				preview.extensions += 1;
				break;
			case "divergence":
				preview.sibling_forks += 1;
				break;
			case "historical":
				preview.historical_versions += 1;
				break;
			case "idempotent":
				preview.duplicates += 1;
				break;
		}
	}
	return preview;
}
