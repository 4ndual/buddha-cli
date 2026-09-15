import type { SessionEntry } from "../../session/session-entries";
import type {
	BranchId,
	ContextHash,
	EventHash,
	MetadataRevisionId,
	OriginId,
	PayloadId,
	ReplicaId,
	SourceAlias,
	VersionId,
} from "../contracts";
import {
	CANONICALIZER_VERSION,
	canonicalIdentityRecord,
	canonicalSha256,
	semanticProjection,
	type CanonicalIdentityRecord,
	type CanonicalValue,
} from "./canonical";

function namespacedHash(namespace: string, value: CanonicalValue): string {
	return `${namespace}:${canonicalSha256({ namespace, value }).slice("sha256:".length)}`;
}

export interface SourceAliasInput {
	harness: string;
	installNamespace: string;
	nativeSessionId: string;
}

export function sourceAlias(input: SourceAliasInput): SourceAlias {
	return namespacedHash("alias-v1", input as unknown as CanonicalValue) as SourceAlias;
}

export function originId(input: SourceAliasInput): OriginId {
	return namespacedHash("origin-v1", input as unknown as CanonicalValue) as OriginId;
}

export function replicaId(profileNamespace: string, installationNonce: string): ReplicaId {
	return namespacedHash("replica-v1", { profileNamespace, installationNonce }) as ReplicaId;
}

/** Removes storage-local lineage fields before semantic event/payload hashing. */
export function sessionEntrySemanticPayload(entry: SessionEntry): CanonicalValue {
	const { id: _id, parentId: _parentId, ...semanticPayload } = entry;
	return semanticPayload as unknown as CanonicalValue;
}

export interface EventIdentityInput {
	originId: OriginId;
	nativeEntryId: string;
	parentHash: EventHash | null;
	kind: string;
	timestamp: string;
	semanticPayload: CanonicalValue;
}

export function eventIdentityRecord(input: EventIdentityInput): CanonicalIdentityRecord & { eventHash: EventHash } {
	const record = canonicalIdentityRecord({
		canonicalizerVersion: CANONICALIZER_VERSION,
		kind: input.kind,
		nativeEntryId: input.nativeEntryId,
		originId: input.originId,
		parentHash: input.parentHash,
		semanticPayload: semanticProjection(input.semanticPayload),
		timestamp: input.timestamp,
	});
	return {
		...record,
		eventHash: `event-v${CANONICALIZER_VERSION}:${record.hash.slice("sha256:".length)}` as EventHash,
	};
}

export function payloadId(payload: CanonicalValue): PayloadId {
	return namespacedHash("payload-v1", semanticProjection(payload)) as PayloadId;
}

export function metadataRevisionId(metadata: CanonicalValue): MetadataRevisionId {
	return namespacedHash("metadata-v1", semanticProjection(metadata)) as MetadataRevisionId;
}

export function contextHash(context: CanonicalValue): ContextHash {
	return namespacedHash("context-v1", semanticProjection(context)) as ContextHash;
}

export interface VersionIdentityInput {
	originId: OriginId;
	headHash: EventHash | null;
	metadataRevisionId: MetadataRevisionId;
}

export function versionId(input: VersionIdentityInput): VersionId {
	return namespacedHash("version-v1", input as unknown as CanonicalValue) as VersionId;
}

export interface BranchIdentityInput {
	originId: OriginId;
	replicaId: ReplicaId;
	branchKey: string;
}

/** Stable across rediscovery; explicit branches with equal content retain different branch keys. */
export function branchId(input: BranchIdentityInput): BranchId {
	return namespacedHash("branch-v1", input as unknown as CanonicalValue) as BranchId;
}

const ID_PATTERNS: Readonly<Record<string, RegExp>> = {
	origin: /^origin-v1:[0-9a-f]{64}$/,
	alias: /^alias-v1:[0-9a-f]{64}$/,
	event: /^event-v1:[0-9a-f]{64}$/,
	version: /^version-v1:[0-9a-f]{64}$/,
	branch: /^branch-v1:[0-9a-f]{64}$/,
	replica: /^replica-v1:[0-9a-f]{64}$/,
	payload: /^payload-v1:[0-9a-f]{64}$/,
	metadata: /^metadata-v1:[0-9a-f]{64}$/,
	context: /^context-v1:[0-9a-f]{64}$/,
};

function validatedId(value: string, kind: keyof typeof ID_PATTERNS): string {
	if (!ID_PATTERNS[kind].test(value)) throw new TypeError(`Invalid ${kind} identity`);
	return value;
}

export function parseOriginId(value: string): OriginId {
	return validatedId(value, "origin") as OriginId;
}

export function parseSourceAlias(value: string): SourceAlias {
	return validatedId(value, "alias") as SourceAlias;
}

export function parseEventHash(value: string): EventHash {
	return validatedId(value, "event") as EventHash;
}

export function parseVersionId(value: string): VersionId {
	return validatedId(value, "version") as VersionId;
}

export function parseBranchId(value: string): BranchId {
	return validatedId(value, "branch") as BranchId;
}

export function parseReplicaId(value: string): ReplicaId {
	return validatedId(value, "replica") as ReplicaId;
}

export function parsePayloadId(value: string): PayloadId {
	return validatedId(value, "payload") as PayloadId;
}

export function parseMetadataRevisionId(value: string): MetadataRevisionId {
	return validatedId(value, "metadata") as MetadataRevisionId;
}

export function parseContextHash(value: string): ContextHash {
	return validatedId(value, "context") as ContextHash;
}
