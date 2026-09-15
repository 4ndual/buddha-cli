import { canonicalJson, sha256, type LogicalBranch, type LogicalBundle, type LogicalEvent, type LogicalVersion } from "./bundle";
import {
	checksumJobValue,
	createMigrationJob,
	readMigrationJob,
	runMigrationJob,
	type JobCommitReceipt,
	type JobItem,
	type MigrationJobRecord,
} from "./jobs";

export type ImportRelationship = "new" | "extension" | "divergence" | "historical" | "idempotent";

export interface ImportVersionPlan {
	source_replica_id: string;
	source_branch_id: string;
	target_branch_id: string;
	relationship: ImportRelationship;
	expected_head_hash: string | null;
	version: LogicalVersion;
	events: readonly LogicalEvent[];
}

export interface ImportBatchResult {
	receipt_id: string;
	commit_checksum: string;
}

/** Adapter boundary: implementations commit versions, events, mappings, and receipt in one transaction. */
export interface LogicalImportTarget {
	readonly replicaId: string;
	readLogicalSnapshot(): Promise<LogicalBundle>;
	lookupBranchMapping(sourceReplicaId: string, sourceBranchId: string): Promise<string | null>;
	applyImportBatch(plans: readonly ImportVersionPlan[], idempotencyKey: string): Promise<ImportBatchResult>;
}

export interface ImportBundleOptions {
	jobId: string;
	journalPath: string;
	maxBatchBytes: number;
	shouldCancel?: () => boolean | Promise<boolean>;
}

export interface ImportBundleResult {
	job: MigrationJobRecord;
	planned: readonly ImportVersionPlan[];
}

interface ImportWorkItem {
	plan: ImportVersionPlan;
}

export async function importLogicalBundle(
	source: LogicalBundle,
	target: LogicalImportTarget,
	options: ImportBundleOptions,
): Promise<ImportBundleResult> {
	const targetSnapshot = await target.readLogicalSnapshot();
	const planned = await planLogicalImport(source, targetSnapshot, target);
	const items: JobItem<ImportWorkItem>[] = planned.map((plan) => {
		const value = plan as unknown as Parameters<typeof checksumJobValue>[0];
		const encoded = canonicalJson(value);
		return {
			key: plan.version.version_id,
			bytes: Buffer.byteLength(encoded),
			checksum: checksumJobValue(value),
			value: { plan },
		};
	});
	let job: MigrationJobRecord;
	try {
		job = await readMigrationJob(options.journalPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		job = await createMigrationJob(options.journalPath, {
			jobId: options.jobId,
			kind: "import",
			maxBatchBytes: options.maxBatchBytes,
			items,
		});
	}
	job = await runMigrationJob({
		journalPath: options.journalPath,
		items,
		shouldCancel: options.shouldCancel,
		executeBatch: async (batch): Promise<JobCommitReceipt> => {
			const itemKeys = batch.map((item) => item.key);
			const idempotencyKey = sha256(canonicalJson({ job_id: options.jobId, item_keys: itemKeys }));
			const result = await target.applyImportBatch(
				batch.map((item) => item.value.plan),
				idempotencyKey,
			);
			return { receipt_id: result.receipt_id, commit_checksum: result.commit_checksum, item_keys: itemKeys };
		},
	});
	return { job, planned };
}

export async function planLogicalImport(
	source: LogicalBundle,
	target: LogicalBundle,
	mappingTarget: Pick<LogicalImportTarget, "lookupBranchMapping">,
): Promise<readonly ImportVersionPlan[]> {
	assertNoHashCollisions(source, target);
	const sourceEvents = new Map(source.events.map((event) => [event.event_hash, event]));
	const allEvents = new Map(target.events.map((event) => [event.event_hash, event]));
	for (const event of source.events) allEvents.set(event.event_hash, event);
	const existingVersions = new Set(target.versions.map((version) => version.version_id));
	const targetBranches = new Map(target.branches.map((branch) => [branch.branch_id, { ...branch }]));
	const sourceBranches = new Map(source.branches.map((branch) => [branch.branch_id, branch]));
	const mappedBranches = new Map<string, string>();
	const ordered = topologicalVersions(source.versions);
	const result: ImportVersionPlan[] = [];
	for (const version of ordered) {
		const sourceBranch = sourceBranches.get(version.branch_id);
		if (!sourceBranch) throw new Error(`Version ${version.version_id} references missing source branch ${version.branch_id}`);
		let mapped = mappedBranches.get(version.branch_id);
		if (!mapped) {
			mapped = (await mappingTarget.lookupBranchMapping(source.replica_id, version.branch_id)) ?? undefined;
			if (mapped) mappedBranches.set(version.branch_id, mapped);
		}
		if (existingVersions.has(version.version_id)) {
			result.push({
				source_replica_id: source.replica_id,
				source_branch_id: version.branch_id,
				target_branch_id: mapped ?? version.branch_id,
				relationship: "idempotent",
				expected_head_hash: targetBranches.get(mapped ?? version.branch_id)?.head_hash ?? null,
				version,
				events: [],
			});
			continue;
		}
		let targetBranchId = mapped ?? version.branch_id;
		let targetBranch = targetBranches.get(targetBranchId);
		if (targetBranch && targetBranch.origin_id !== version.origin_id) {
			targetBranchId = derivedBranchId(source.replica_id, version.branch_id, version.version_id);
			targetBranch = targetBranches.get(targetBranchId);
		}
		let relationship: ImportRelationship = "new";
		let expectedHead: string | null = null;
		if (targetBranch) {
			expectedHead = targetBranch.head_hash;
			if (targetBranch.head_hash === version.head_hash) relationship = "idempotent";
			else if (isAncestor(targetBranch.head_hash, version.head_hash, allEvents)) relationship = "extension";
			else {
				relationship = isAncestor(version.head_hash, targetBranch.head_hash, allEvents) ? "historical" : "divergence";
				targetBranchId = mapped ?? derivedBranchId(source.replica_id, version.branch_id, version.version_id);
				targetBranch = targetBranches.get(targetBranchId);
				expectedHead = targetBranch?.head_hash ?? null;
			}
		}
		mappedBranches.set(version.branch_id, targetBranchId);
		const events = collectMissingAncestry(version.head_hash, sourceEvents, allEvents, new Set(target.events.map((event) => event.event_hash)));
		result.push({
			source_replica_id: source.replica_id,
			source_branch_id: version.branch_id,
			target_branch_id: targetBranchId,
			relationship,
			expected_head_hash: expectedHead,
			version,
			events,
		});
		existingVersions.add(version.version_id);
		targetBranches.set(targetBranchId, {
			branch_id: targetBranchId,
			origin_id: version.origin_id,
			parent_branch_id: relationship === "divergence" || relationship === "historical" ? targetBranch?.branch_id ?? null : sourceBranch.parent_branch_id,
			fork_point_hash: version.fork_point_hash,
			head_hash: version.head_hash,
			head_version_id: version.version_id,
		});
	}
	return result;
}

export function isAncestor(
	possibleAncestor: string | null,
	descendant: string | null,
	events: ReadonlyMap<string, LogicalEvent>,
): boolean {
	if (possibleAncestor === null) return true;
	let cursor = descendant;
	const visited = new Set<string>();
	while (cursor !== null) {
		if (cursor === possibleAncestor) return true;
		if (visited.has(cursor)) throw new Error(`Cycle in event ancestry at ${cursor}`);
		visited.add(cursor);
		const event = events.get(cursor);
		if (!event) return false;
		cursor = event.parent_hash;
	}
	return false;
}

function collectMissingAncestry(
	head: string | null,
	sourceEvents: ReadonlyMap<string, LogicalEvent>,
	allEvents: ReadonlyMap<string, LogicalEvent>,
	targetHashes: ReadonlySet<string>,
): readonly LogicalEvent[] {
	const reversed: LogicalEvent[] = [];
	let cursor = head;
	const visited = new Set<string>();
	while (cursor !== null && !targetHashes.has(cursor)) {
		if (visited.has(cursor)) throw new Error(`Cycle in source ancestry at ${cursor}`);
		visited.add(cursor);
		const event = sourceEvents.get(cursor) ?? allEvents.get(cursor);
		if (!event) throw new Error(`Missing source event ${cursor}`);
		reversed.push(event);
		cursor = event.parent_hash;
	}
	return reversed.reverse();
}

function topologicalVersions(versions: readonly LogicalVersion[]): LogicalVersion[] {
	const byId = new Map(versions.map((version) => [version.version_id, version]));
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const result: LogicalVersion[] = [];
	const visit = (version: LogicalVersion): void => {
		if (visited.has(version.version_id)) return;
		if (visiting.has(version.version_id)) throw new Error(`Cycle in version ancestry at ${version.version_id}`);
		visiting.add(version.version_id);
		if (version.parent_version_id) {
			const parent = byId.get(version.parent_version_id);
			if (parent) visit(parent);
		}
		visiting.delete(version.version_id);
		visited.add(version.version_id);
		result.push(version);
	};
	for (const version of versions) visit(version);
	return result;
}

function assertNoHashCollisions(source: LogicalBundle, target: LogicalBundle): void {
	const targetEvents = new Map(target.events.map((event) => [event.event_hash, canonicalJson(event as unknown as Parameters<typeof canonicalJson>[0])]));
	for (const event of source.events) {
		const existing = targetEvents.get(event.event_hash);
		if (existing !== undefined && existing !== canonicalJson(event as unknown as Parameters<typeof canonicalJson>[0])) {
			throw new Error(`Event hash collision for ${event.event_hash}`);
		}
	}
}

function derivedBranchId(sourceReplicaId: string, sourceBranchId: string, versionId: string): string {
	return `import-${sha256(`${sourceReplicaId}\0${sourceBranchId}\0${versionId}`).slice(0, 32)}`;
}
