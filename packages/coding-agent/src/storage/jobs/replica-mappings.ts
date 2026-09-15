import * as path from "node:path";
import type { ReplicaId } from "../contracts";
import { checksumJobJson } from "./checksum";
import { durableIo, type DurableIo, pathExists, writeJsonAtomicDurable } from "./durable-fs";
import {
	reconcileSameOrigin,
	type ReconcilePlan,
	type ReplicaBranchMapping,
	type SyncVersionSnapshot,
} from "./reconcile";

interface ReplicaMappingSnapshot {
	schemaVersion: 1;
	mappings: readonly ReplicaBranchMapping[];
	updatedAt: string;
	checksum: string;
}

function mappingKey(mapping: ReplicaBranchMapping): string {
	return `${mapping.originId}\u0000${mapping.sourceReplicaId}\u0000${mapping.sourceBranchId}\u0000${mapping.targetReplicaId}`;
}

function snapshotBody(snapshot: Omit<ReplicaMappingSnapshot, "checksum">) {
	return {
		schemaVersion: snapshot.schemaVersion,
		mappings: snapshot.mappings.map(mapping => ({
			originId: mapping.originId,
			sourceReplicaId: mapping.sourceReplicaId,
			sourceBranchId: mapping.sourceBranchId,
			targetReplicaId: mapping.targetReplicaId,
			targetBranchId: mapping.targetBranchId,
			versionId: mapping.versionId,
		})),
		updatedAt: snapshot.updatedAt,
	};
}

function validateSnapshot(input: unknown): ReplicaMappingSnapshot {
	if (!input || typeof input !== "object") throw new Error("Replica mapping state is not an object");
	const snapshot = input as Partial<ReplicaMappingSnapshot>;
	if (
		snapshot.schemaVersion !== 1 ||
		!Array.isArray(snapshot.mappings) ||
		typeof snapshot.updatedAt !== "string" ||
		typeof snapshot.checksum !== "string"
	) {
		throw new Error("Replica mapping state has an invalid shape");
	}
	const complete = snapshot as ReplicaMappingSnapshot;
	if (checksumJobJson(snapshotBody(complete)) !== complete.checksum) {
		throw new Error("Replica mapping state checksum mismatch");
	}
	const observed = new Map<string, string>();
	for (const mapping of complete.mappings) {
		const key = mappingKey(mapping);
		const target = observed.get(key);
		if (target && target !== mapping.targetBranchId) throw new Error(`Conflicting replica mapping for ${key}`);
		observed.set(key, mapping.targetBranchId);
	}
	return complete;
}

export class ReplicaBranchMappingStore {
	readonly #filePath: string;
	readonly #io: DurableIo;
	#snapshot: ReplicaMappingSnapshot;

	private constructor(filePath: string, snapshot: ReplicaMappingSnapshot, io: DurableIo) {
		this.#filePath = filePath;
		this.#snapshot = snapshot;
		this.#io = io;
	}

	static async open(filePath: string, io: DurableIo = durableIo): Promise<ReplicaBranchMappingStore> {
		if (await pathExists(filePath, io)) {
			const snapshot = validateSnapshot(JSON.parse(await io.readText(filePath)) as unknown);
			return new ReplicaBranchMappingStore(filePath, snapshot, io);
		}
		const body = { schemaVersion: 1 as const, mappings: [], updatedAt: new Date(0).toISOString() };
		const snapshot: ReplicaMappingSnapshot = { ...body, checksum: checksumJobJson(snapshotBody(body)) };
		await writeJsonAtomicDurable(filePath, snapshot, io);
		return new ReplicaBranchMappingStore(filePath, snapshot, io);
	}

	get mappings(): readonly ReplicaBranchMapping[] {
		return structuredClone(this.#snapshot.mappings);
	}

	async putAll(mappings: readonly ReplicaBranchMapping[], now: () => string = () => new Date().toISOString()): Promise<void> {
		if (mappings.length === 0) return;
		const merged = new Map(this.#snapshot.mappings.map(mapping => [mappingKey(mapping), mapping]));
		for (const mapping of mappings) {
			const key = mappingKey(mapping);
			const existing = merged.get(key);
			if (existing && existing.targetBranchId !== mapping.targetBranchId) {
				throw new Error(`Replica branch mapping collision for ${key}`);
			}
			merged.set(key, mapping);
		}
		const body = {
			schemaVersion: 1 as const,
			mappings: [...merged.values()].sort((left, right) => mappingKey(left).localeCompare(mappingKey(right))),
			updatedAt: now(),
		};
		const snapshot: ReplicaMappingSnapshot = { ...body, checksum: checksumJobJson(snapshotBody(body)) };
		await writeJsonAtomicDurable(this.#filePath, snapshot, this.#io);
		this.#snapshot = snapshot;
	}
}

/** Reserves stable target branch identities durably before a caller applies the additive plan. */
export async function reconcileAndPersistSameOrigin(options: {
	mappingStore: ReplicaBranchMappingStore;
	targetReplicaId: ReplicaId;
	sourceReplicaId: ReplicaId;
	target: readonly SyncVersionSnapshot[];
	source: readonly SyncVersionSnapshot[];
}): Promise<ReconcilePlan> {
	const plan = reconcileSameOrigin({
		targetReplicaId: options.targetReplicaId,
		sourceReplicaId: options.sourceReplicaId,
		target: options.target,
		source: options.source,
		mappings: options.mappingStore.mappings,
	});
	await options.mappingStore.putAll(plan.mappings);
	return plan;
}

export function defaultReplicaMappingPath(jobDirectory: string): string {
	return path.join(jobDirectory, "replica-branch-mappings.json");
}
