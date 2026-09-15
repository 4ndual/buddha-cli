import type {
	BranchId,
	EventHash,
	MetadataRevisionId,
	OriginId,
	ReplicaId,
	VersionId,
} from "../contracts";
import { checksumJobJson } from "./checksum";

export interface SyncVersionSnapshot {
	originId: OriginId;
	versionId: VersionId;
	branchId: BranchId;
	parentVersionId: VersionId | null;
	headHash: EventHash | null;
	metadataRevisionId: MetadataRevisionId;
	eventHashes: readonly EventHash[];
}

export interface ReplicaBranchMapping {
	originId: OriginId;
	sourceReplicaId: ReplicaId;
	sourceBranchId: BranchId;
	targetReplicaId: ReplicaId;
	targetBranchId: BranchId;
	versionId: VersionId;
}

export type ReconcileActionKind =
	| "no-op"
	| "import"
	| "extend"
	| "sibling-fork"
	| "metadata-version"
	| "attach-branch";

export interface ReconcileAction {
	kind: ReconcileActionKind;
	originId: OriginId;
	versionId: VersionId;
	sourceBranchId: BranchId;
	targetBranchId: BranchId;
	parentVersionId: VersionId | null;
	forkPointHash: EventHash | null;
}

export interface ReconcilePlan {
	actions: readonly ReconcileAction[];
	mappings: readonly ReplicaBranchMapping[];
	counts: {
		noOp: number;
		imports: number;
		extensions: number;
		siblingForks: number;
		metadataVersions: number;
		attachedBranches: number;
		deletions: 0;
	};
}

function mappingKey(
	mapping: Pick<ReplicaBranchMapping, "originId" | "sourceReplicaId" | "sourceBranchId" | "targetReplicaId">,
): string {
	return `${mapping.originId}\u0000${mapping.sourceReplicaId}\u0000${mapping.sourceBranchId}\u0000${mapping.targetReplicaId}`;
}

function versionKey(version: Pick<SyncVersionSnapshot, "originId" | "versionId">): string {
	return `${version.originId}\u0000${version.versionId}`;
}

function sharedPrefixLength(left: readonly EventHash[], right: readonly EventHash[]): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

function sameEventPath(left: readonly EventHash[], right: readonly EventHash[]): boolean {
	return left.length === right.length && sharedPrefixLength(left, right) === left.length;
}

function stableImportedBranchId(
	targetReplicaId: ReplicaId,
	sourceReplicaId: ReplicaId,
	originId: OriginId,
	sourceBranchId: BranchId,
): BranchId {
	return `sync-${checksumJobJson({ targetReplicaId, sourceReplicaId, originId, sourceBranchId })}` as BranchId;
}

function bestRelatedVersion(
	target: readonly SyncVersionSnapshot[],
	source: SyncVersionSnapshot,
	preferredBranch: BranchId | null,
): SyncVersionSnapshot | null {
	let best: SyncVersionSnapshot | null = null;
	let bestShared = -1;
	for (const candidate of target) {
		if (candidate.originId !== source.originId) continue;
		const shared = sharedPrefixLength(candidate.eventHashes, source.eventHashes);
		const preferred = preferredBranch !== null && candidate.branchId === preferredBranch;
		const currentPreferred = best !== null && preferredBranch !== null && best.branchId === preferredBranch;
		const winsTie =
			shared === bestShared &&
			((preferred && !currentPreferred) ||
				(preferred === currentPreferred && candidate.eventHashes.length > (best?.eventHashes.length ?? -1)));
		if (shared > bestShared || winsTie) {
			best = candidate;
			bestShared = shared;
		}
	}
	return best;
}

/**
 * Builds an additive plan. Missing source items never create delete actions, and branch IDs are
 * deterministic until the returned mappings have been durably stored by the target repository.
 */
export function reconcileSameOrigin(options: {
	targetReplicaId: ReplicaId;
	sourceReplicaId: ReplicaId;
	target: readonly SyncVersionSnapshot[];
	source: readonly SyncVersionSnapshot[];
	mappings: readonly ReplicaBranchMapping[];
}): ReconcilePlan {
	const targetByVersion = new Map(options.target.map(version => [versionKey(version), version]));
	const mappingByKey = new Map(options.mappings.map(mapping => [mappingKey(mapping), mapping]));
	const newMappings: ReplicaBranchMapping[] = [];
	const actions: ReconcileAction[] = [];

	for (const source of options.source) {
		const existing = targetByVersion.get(versionKey(source));
		const key = mappingKey({
			originId: source.originId,
			sourceReplicaId: options.sourceReplicaId,
			sourceBranchId: source.branchId,
			targetReplicaId: options.targetReplicaId,
		});
		const knownMapping = mappingByKey.get(key);
		const targetBranchId =
			knownMapping?.targetBranchId ??
			stableImportedBranchId(options.targetReplicaId, options.sourceReplicaId, source.originId, source.branchId);

		if (!knownMapping) {
			const mapping: ReplicaBranchMapping = {
				originId: source.originId,
				sourceReplicaId: options.sourceReplicaId,
				sourceBranchId: source.branchId,
				targetReplicaId: options.targetReplicaId,
				targetBranchId,
				versionId: source.versionId,
			};
			mappingByKey.set(key, mapping);
			newMappings.push(mapping);
		}

		if (existing) {
			actions.push({
				kind: existing.branchId === targetBranchId ? "no-op" : "attach-branch",
				originId: source.originId,
				versionId: source.versionId,
				sourceBranchId: source.branchId,
				targetBranchId,
				parentVersionId: existing.parentVersionId,
				forkPointHash: source.headHash,
			});
			continue;
		}

		const related = bestRelatedVersion(options.target, source, knownMapping?.targetBranchId ?? null);
		if (!related) {
			actions.push({
				kind: "import",
				originId: source.originId,
				versionId: source.versionId,
				sourceBranchId: source.branchId,
				targetBranchId,
				parentVersionId: source.parentVersionId,
				forkPointHash: null,
			});
			continue;
		}

		const shared = sharedPrefixLength(related.eventHashes, source.eventHashes);
		const samePath = sameEventPath(related.eventHashes, source.eventHashes);
		let kind: ReconcileActionKind;
		if (samePath) {
			kind = "metadata-version";
		} else if (
			shared === related.eventHashes.length &&
			source.eventHashes.length > related.eventHashes.length &&
			(knownMapping === undefined || related.branchId === knownMapping.targetBranchId)
		) {
			kind = "extend";
		} else {
			kind = "sibling-fork";
		}
		const sourceParentExists =
			source.parentVersionId !== null &&
			targetByVersion.has(versionKey({ originId: source.originId, versionId: source.parentVersionId }));
		actions.push({
			kind,
			originId: source.originId,
			versionId: source.versionId,
			sourceBranchId: source.branchId,
			targetBranchId,
			parentVersionId: sourceParentExists ? source.parentVersionId : related.versionId,
			forkPointHash: shared === 0 ? null : source.eventHashes[shared - 1]!,
		});
	}

	return {
		actions,
		mappings: newMappings,
		counts: {
			noOp: actions.filter(action => action.kind === "no-op").length,
			imports: actions.filter(action => action.kind === "import").length,
			extensions: actions.filter(action => action.kind === "extend").length,
			siblingForks: actions.filter(action => action.kind === "sibling-fork").length,
			metadataVersions: actions.filter(action => action.kind === "metadata-version").length,
			attachedBranches: actions.filter(action => action.kind === "attach-branch").length,
			deletions: 0,
		},
	};
}
