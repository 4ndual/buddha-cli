import type { BranchId, EventHash, OriginId, ReplicaId, SourceAlias, VersionId } from "../contracts";
import { assertSameCanonicalIdentity, type CanonicalIdentityRecord } from "./canonical";
import { branchId } from "./identifiers";

export type ReconciliationAction =
	| "no-op"
	| "import-suffix-cas"
	| "preserve-sibling-branches"
	| "fork-conflicting-event"
	| "fork-historical-edit"
	| "preserve-metadata-revisions"
	| "retain-unresolved"
	| "ignore-absence";

export interface ReconciliationObservation {
	sameOrigin: boolean;
	sameVersion: boolean;
	currentIsVerifiedAncestor: boolean;
	incomingIsVerifiedAncestor: boolean;
	bothExtendSameBaseDifferently: boolean;
	sameNativeEventIdDifferentPayload: boolean;
	historicalEditOrTruncation: boolean;
	metadataOnlyDivergence: boolean;
	identityResolved: boolean;
	oneSideAbsent: boolean;
}

/** Executable form of the no-merge matrix; ordering gives conflicts precedence over ancestry. */
export function reconcileAction(observation: ReconciliationObservation): ReconciliationAction {
	if (observation.oneSideAbsent) return "ignore-absence";
	if (!observation.identityResolved || !observation.sameOrigin) return "retain-unresolved";
	if (observation.sameNativeEventIdDifferentPayload) return "fork-conflicting-event";
	if (observation.historicalEditOrTruncation) return "fork-historical-edit";
	if (observation.metadataOnlyDivergence) return "preserve-metadata-revisions";
	if (observation.sameVersion) return "no-op";
	if (observation.bothExtendSameBaseDifferently) return "preserve-sibling-branches";
	if (observation.currentIsVerifiedAncestor || observation.incomingIsVerifiedAncestor) return "import-suffix-cas";
	return "preserve-sibling-branches";
}

export interface ImmutableEventIdentity {
	hash: EventHash;
	identity: CanonicalIdentityRecord;
}

export interface ImmutablePrefixComparison {
	sharedLength: number;
	relationship: "equal" | "existing-prefix" | "incoming-prefix" | "diverged";
	forkPointHash: EventHash | null;
}

/** Compares immutable event sequences without copying their shared prefix. */
export function compareImmutablePrefixes(
	existing: readonly ImmutableEventIdentity[],
	incoming: readonly ImmutableEventIdentity[],
): ImmutablePrefixComparison {
	const sharedLimit = Math.min(existing.length, incoming.length);
	let sharedLength = 0;
	while (sharedLength < sharedLimit && existing[sharedLength].hash === incoming[sharedLength].hash) {
		assertSameCanonicalIdentity(existing[sharedLength].identity, incoming[sharedLength].identity);
		sharedLength++;
	}
	const forkPointHash = sharedLength === 0 ? null : existing[sharedLength - 1].hash;
	if (sharedLength === existing.length && sharedLength === incoming.length) {
		return { sharedLength, relationship: "equal", forkPointHash };
	}
	if (sharedLength === existing.length) return { sharedLength, relationship: "existing-prefix", forkPointHash };
	if (sharedLength === incoming.length) return { sharedLength, relationship: "incoming-prefix", forkPointHash };
	return { sharedLength, relationship: "diverged", forkPointHash };
}

export interface CasAppendObservation {
	originId: OriginId;
	replicaId: ReplicaId;
	branchId: BranchId;
	expectedHeadHash: EventHash | null;
	actualHeadHash: EventHash | null;
	incomingEventHash: EventHash;
	operationId: string;
}

export type CasAppendPlan =
	| { outcome: "append"; branchId: BranchId; parentHash: EventHash | null }
	| { outcome: "idempotent"; branchId: BranchId; eventHash: EventHash }
	| {
			outcome: "sibling-fork";
			branchId: BranchId;
			winnerBranchId: BranchId;
			forkPointHash: EventHash | null;
			parentHash: EventHash | null;
	  };

/** A CAS loser keeps its original parent and is assigned a stable sibling branch. */
export function planCasAppend(observation: CasAppendObservation): CasAppendPlan {
	if (observation.actualHeadHash === observation.incomingEventHash) {
		return { outcome: "idempotent", branchId: observation.branchId, eventHash: observation.incomingEventHash };
	}
	if (observation.actualHeadHash === observation.expectedHeadHash) {
		return { outcome: "append", branchId: observation.branchId, parentHash: observation.expectedHeadHash };
	}
	return {
		outcome: "sibling-fork",
		branchId: branchId({
			originId: observation.originId,
			replicaId: observation.replicaId,
			branchKey: `cas-loser:${observation.branchId}:${observation.operationId}`,
		}),
		winnerBranchId: observation.branchId,
		forkPointHash: observation.expectedHeadHash,
		parentHash: observation.expectedHeadHash,
	};
}

export interface DurableBranchMapping {
	originId: OriginId;
	replicaId: ReplicaId;
	sourceAlias: SourceAlias;
	canonicalVersionId: VersionId;
	branchId: BranchId;
}

export function durableBranchMappingKey(mapping: Omit<DurableBranchMapping, "branchId">): string {
	return `${mapping.originId}\0${mapping.replicaId}\0${mapping.sourceAlias}\0${mapping.canonicalVersionId}`;
}
