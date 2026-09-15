import { canonicalSerialize } from "./canonical";
import type {
	BranchId,
	EventHash,
	ModeGeneration,
	OriginId,
	ReplicaId,
	SessionSemanticMetadata,
	SourceAlias,
	SourceIdentity,
	VersionId,
} from "./types";

export const SESSION_IDENTITY_VERSION = 1 as const;

export interface IdentityProof<Id extends string = string> {
	id: Id;
	canonicalLength: number;
	canonicalSha256: string;
	canonicalBytes: Uint8Array;
}

export interface EventIdentityInput {
	originId: OriginId;
	nativeEntryId: string;
	parentEventHash: EventHash | null;
	semanticPayload: unknown;
}

export interface VersionIdentityInput {
	originId: OriginId;
	headEventHash: EventHash | null;
	/** The complete immutable tree revision. Ordering does not affect identity. */
	treeEventHashes: readonly EventHash[];
	metadata: SessionSemanticMetadata | Readonly<Record<string, unknown>>;
}

export interface BranchIdentityInput {
	originId: OriginId;
	replicaId: ReplicaId;
	/** Stable caller/import mapping key, not a mutable head or filesystem path. */
	branchKey: string;
}

export class IdentityCollisionError extends Error {
	readonly identity: string;

	constructor(identity: string) {
		super(`Identity collision detected for ${identity}`);
		this.name = "IdentityCollisionError";
		this.identity = identity;
	}
}

export class IdentityClaimError extends Error {
	constructor(expected: string, computed: string) {
		super(`Identity claim ${expected} does not match canonical identity ${computed}`);
		this.name = "IdentityClaimError";
	}
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function proof<Id extends string>(prefix: string, semanticEnvelope: unknown): IdentityProof<Id> {
	const canonicalBytes = canonicalSerialize(semanticEnvelope);
	const canonicalSha256 = sha256(canonicalBytes);
	return {
		id: `${prefix}_v${SESSION_IDENTITY_VERSION}_${canonicalSha256}` as Id,
		canonicalLength: canonicalBytes.byteLength,
		canonicalSha256,
		canonicalBytes,
	};
}

export function computeSourceAlias(source: SourceIdentity): IdentityProof<SourceAlias> {
	return proof<SourceAlias>("src", {
		kind: "source-alias",
		version: SESSION_IDENTITY_VERSION,
		sourceNamespace: source.sourceNamespace,
		installationNamespace: source.installationNamespace,
		nativeId: source.nativeId,
	});
}

export function computeOriginIdentity(source: SourceIdentity): IdentityProof<OriginId> {
	return proof<OriginId>("origin", {
		kind: "origin",
		version: SESSION_IDENTITY_VERSION,
		sourceNamespace: source.sourceNamespace,
		installationNamespace: source.installationNamespace,
		nativeId: source.nativeId,
	});
}

export function computeEventIdentity(input: EventIdentityInput): IdentityProof<EventHash> {
	return proof<EventHash>("event", {
		kind: "event",
		version: SESSION_IDENTITY_VERSION,
		originId: input.originId,
		nativeEntryId: input.nativeEntryId,
		parentEventHash: input.parentEventHash,
		semanticPayload: input.semanticPayload,
	});
}

export function computeVersionIdentity(input: VersionIdentityInput): IdentityProof<VersionId> {
	const treeEventHashes = [...input.treeEventHashes].sort();
	return proof<VersionId>("version", {
		kind: "version",
		version: SESSION_IDENTITY_VERSION,
		originId: input.originId,
		headEventHash: input.headEventHash,
		treeEventHashes,
		metadata: input.metadata,
	});
}

export function computeBranchIdentity(input: BranchIdentityInput): IdentityProof<BranchId> {
	return proof<BranchId>("branch", {
		kind: "branch",
		version: SESSION_IDENTITY_VERSION,
		originId: input.originId,
		replicaId: input.replicaId,
		branchKey: input.branchKey,
	});
}

/** Create a caller-owned replica identity without relying on a filesystem path. */
export function computeReplicaIdentity(replicaKey: string): IdentityProof<ReplicaId> {
	return proof<ReplicaId>("replica", {
		kind: "replica",
		version: SESSION_IDENTITY_VERSION,
		replicaKey,
	});
}

/** Mode generations are persisted opaque tokens, not monotonic-clock guesses. */
export function modeGeneration(value: string): ModeGeneration {
	if (value.length === 0) throw new TypeError("Mode generation must not be empty");
	return value as ModeGeneration;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/**
 * Detects the otherwise catastrophic case where one identifier names different
 * canonical bytes. Repeated registration of the same proof is idempotent.
 */
export class IdentityCollisionRegistry {
	readonly #proofs = new Map<string, IdentityProof>();

	remember<Id extends string>(candidate: IdentityProof<Id>): void {
		const existing = this.#proofs.get(candidate.id);
		if (!existing) {
			this.#proofs.set(candidate.id, {
				...candidate,
				canonicalBytes: candidate.canonicalBytes.slice(),
			});
			return;
		}
		if (
			existing.canonicalLength !== candidate.canonicalLength ||
			existing.canonicalSha256 !== candidate.canonicalSha256 ||
			!bytesEqual(existing.canonicalBytes, candidate.canonicalBytes)
		) {
			throw new IdentityCollisionError(candidate.id);
		}
	}
}

export function assertIdentityClaim<Id extends string>(claimed: Id, computed: IdentityProof<Id>): void {
	if (claimed !== computed.id) throw new IdentityClaimError(claimed, computed.id);
}
