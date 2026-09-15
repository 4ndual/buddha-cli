import { describe, expect, it } from "bun:test";
import {
	checkpointKey,
	TursoSessionRepository,
	type DbBranchRow,
	type DbCheckpoint,
	type DbEventInput,
	type DbEventRef,
	type DbHealth,
	type DbPayloadInput,
	type DbSearchHit,
	type DbSessionHeader,
	type DbSessionListRow,
	type DbTreeRow,
	type DurableFlushReceipt,
	type StorageGenerationFence,
	type TursoRuntimeAdapter,
	type TursoRuntimeTransaction,
} from "../../../../src/session/repository/turso/repository";
import { ByteBoundedWriterQueue } from "../../../../src/session/repository/turso/worker-queue";
import type { KeysetPosition } from "../../../../src/session/repository/turso/pagination";

const FENCE: StorageGenerationFence = { replica_id: "replica-a", generation: 7, token: "mode-db-7" };
const NOW = "2026-09-15T00:00:00.000Z";

function payload(id: string, text = id): DbPayloadInput {
	const bytes = new TextEncoder().encode(text);
	return { payload_id: id, content_hash: `hash-${id}`, codec: "identity", uncompressed_bytes: bytes.byteLength, bytes };
}

function event(hash: string, parent: string | null, payloadInput = payload(`payload-${hash}`)): DbEventInput {
	return {
		event_hash: hash,
		origin_id: "origin-a",
		parent_hash: parent,
		native_entry_id: `native-${hash}`,
		kind: "message",
		timestamp: NOW,
		payload: payloadInput,
		canonicalizer_version: "canonical-v1",
	};
}

class MemoryRuntimeAdapter implements TursoRuntimeAdapter, TursoRuntimeTransaction {
	readonly branches = new Map<string, DbBranchRow>();
	readonly events = new Map<string, DbEventInput>();
	readonly payloads = new Map<string, Uint8Array>();
	readonly checkpoints = new Map<string, DbCheckpoint>();
	readonly headers = new Map<string, DbSessionHeader>();
	readonly listRows: DbSessionListRow[] = [];
	readonly searchRows: DbSearchHit[] = [];
	readonly treeRows: DbTreeRow[] = [];
	readonly observedLimits = { list: [] as number[], search: [] as number[], tree: [] as number[], tail: [] as number[] };
	payloadStreamStarted = false;
	transactionCount = 0;
	closed = false;

	constructor() {
		const root = event("base", null);
		this.events.set(root.event_hash, root);
		this.payloads.set(root.payload.payload_id, root.payload.bytes);
		this.branches.set("main", {
			branch_id: "main",
			origin_id: "origin-a",
			parent_branch_id: null,
			fork_point_hash: null,
			head_hash: "base",
			head_version_id: "version-base",
			generation: 1,
		});
		this.headers.set("main", this.headerFor("main", "version-base", "meta-base"));
	}

	async transaction<T>(work: (tx: TursoRuntimeTransaction) => Promise<T>): Promise<T> {
		this.transactionCount += 1;
		return work(this);
	}

	async assertModeGeneration(fence: StorageGenerationFence): Promise<void> {
		if (JSON.stringify(fence) !== JSON.stringify(FENCE)) throw new Error("stale mode generation");
	}

	async getBranch(branchId: string): Promise<DbBranchRow | undefined> {
		return this.branches.get(branchId);
	}

	async isEventReachable(branchId: string, eventHash: string | null): Promise<boolean> {
		if (eventHash === null) return true;
		let cursor = this.branches.get(branchId)?.head_hash ?? null;
		while (cursor !== null) {
			if (cursor === eventHash) return true;
			cursor = this.events.get(cursor)?.parent_hash ?? null;
		}
		return false;
	}

	async insertImmutablePayloads(inputs: readonly DbPayloadInput[]): Promise<void> {
		for (const input of inputs) {
			const existing = this.payloads.get(input.payload_id);
			if (existing && !existing.every((byte, index) => input.bytes[index] === byte)) throw new Error("payload collision");
			this.payloads.set(input.payload_id, input.bytes);
		}
	}

	async insertImmutableEvents(inputs: readonly DbEventInput[]): Promise<void> {
		for (const input of inputs) {
			const existing = this.events.get(input.event_hash);
			if (existing && existing.payload.content_hash !== input.payload.content_hash) throw new Error("event collision");
			this.events.set(input.event_hash, input);
		}
	}

	async tryAdvanceBranch(input: {
		branch_id: string;
		expected_head_hash: string | null;
		new_head_hash: string;
		version: { version_id: string; metadata_revision_id: string };
	}): Promise<boolean> {
		const branch = this.branches.get(input.branch_id)!;
		if (branch.head_hash !== input.expected_head_hash) return false;
		this.branches.set(input.branch_id, {
			...branch,
			head_hash: input.new_head_hash,
			head_version_id: input.version.version_id,
			generation: branch.generation + 1,
		});
		this.headers.set(input.branch_id, this.headerFor(input.branch_id, input.version.version_id, input.version.metadata_revision_id));
		return true;
	}

	async ensureBranch(input: {
		branch: DbBranchRow;
		version: { version_id: string; metadata_revision_id: string };
	}): Promise<void> {
		const existing = this.branches.get(input.branch.branch_id);
		if (existing && existing.head_hash !== input.branch.head_hash) throw new Error("branch collision");
		this.branches.set(input.branch.branch_id, input.branch);
		this.headers.set(
			input.branch.branch_id,
			this.headerFor(input.branch.branch_id, input.version.version_id, input.version.metadata_revision_id),
		);
	}

	async putCheckpoint(value: DbCheckpoint): Promise<void> {
		this.checkpoints.set(value.checkpoint_key, value);
	}

	async listBranches(query: {
		after?: KeysetPosition;
		limit: number;
		origin_id?: string;
	}): Promise<readonly DbSessionListRow[]> {
		this.observedLimits.list.push(query.limit);
		return after(this.listRows, query.after, row => ({ sortKey: row.sort_key, id: row.branch_id }))
			.filter(row => query.origin_id === undefined || row.origin_id === query.origin_id)
			.slice(0, query.limit);
	}

	async searchEvents(query: {
		text: string;
		after?: KeysetPosition;
		limit: number;
		origin_id?: string;
		branch_id?: string;
	}): Promise<readonly DbSearchHit[]> {
		this.observedLimits.search.push(query.limit);
		return after(this.searchRows, query.after, row => ({
			sortKey: row.sort_key,
			id: `${row.branch_id}:${row.event_hash}`,
		}))
			.filter(row => row.snippet.includes(query.text))
			.slice(0, query.limit);
	}

	async readTreePage(query: {
		branch_id: string;
		after?: KeysetPosition;
		limit: number;
	}): Promise<readonly DbTreeRow[]> {
		this.observedLimits.tree.push(query.limit);
		return after(this.treeRows, query.after, row => ({ sortKey: row.sort_key, id: row.event_hash })).slice(0, query.limit);
	}

	async getHeader(branchId: string): Promise<DbSessionHeader | undefined> {
		return this.headers.get(branchId);
	}

	async readAncestryTail(query: {
		branch_id: string;
		head_hash?: string;
		limit: number;
	}): Promise<readonly DbEventRef[]> {
		this.observedLimits.tail.push(query.limit);
		const result: DbEventRef[] = [];
		let cursor = query.head_hash ?? this.branches.get(query.branch_id)?.head_hash ?? null;
		while (cursor !== null && result.length < query.limit) {
			const value = this.events.get(cursor)!;
			result.push({
				event_hash: value.event_hash,
				origin_id: value.origin_id,
				parent_hash: value.parent_hash,
				native_entry_id: value.native_entry_id,
				kind: value.kind,
				timestamp: value.timestamp,
				payload_id: value.payload.payload_id,
				payload_bytes: value.payload.uncompressed_bytes,
			});
			cursor = value.parent_hash;
		}
		return result;
	}

	async *streamPayloadChunks(query: {
		payload_id: string;
		chunk_bytes: number;
		signal?: AbortSignal;
	}): AsyncIterable<Uint8Array> {
		this.payloadStreamStarted = true;
		const bytes = this.payloads.get(query.payload_id);
		if (!bytes) throw new Error("missing payload");
		for (let offset = 0; offset < bytes.byteLength; offset += query.chunk_bytes) {
			if (query.signal?.aborted) throw query.signal.reason;
			yield bytes.subarray(offset, offset + query.chunk_bytes);
		}
	}

	async getCheckpoint(key: string): Promise<DbCheckpoint | undefined> {
		return this.checkpoints.get(key);
	}

	async health(): Promise<DbHealth> {
		return { ok: true, writable: true, schemaVersion: 2 };
	}

	async flush(fence: StorageGenerationFence): Promise<DurableFlushReceipt> {
		await this.assertModeGeneration(fence);
		return { ...fence, committed_sequence: "memory-1", fsynced: true, checkpointed: true };
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	headerFor(branchId: string, versionId: string, metadataRevisionId: string): DbSessionHeader {
		const branch = this.branches.get(branchId);
		return {
			origin_id: branch?.origin_id ?? "origin-a",
			branch_id: branchId,
			version_id: versionId,
			head_hash: branch?.head_hash ?? null,
			generation: branch?.generation ?? 1,
			created_at: NOW,
			updated_at: NOW,
			metadata_revision_id: metadataRevisionId,
		};
	}
}

function after<T>(rows: readonly T[], position: KeysetPosition | undefined, key: (row: T) => KeysetPosition): T[] {
	if (!position) return rows.slice();
	return rows.filter(row => {
		const candidate = key(row);
		return candidate.sortKey > position.sortKey || (candidate.sortKey === position.sortKey && candidate.id > position.id);
	});
}

function appendInput(entryInput: DbEventInput, versionId: string) {
	return {
		fence: FENCE,
		originId: "origin-a",
		branchId: "main",
		expectedHeadHash: entryInput.parent_hash,
		parentVersionId: "version-base",
		versionId,
		metadataRevisionId: "meta-a",
		createdAt: NOW,
		entries: [entryInput],
	};
}

describe("TursoSessionRepository mutations", () => {
	it("CAS-appends the winner and deterministically preserves the loser as a sibling", async () => {
		const adapter = new MemoryRuntimeAdapter();
		const repository = new TursoSessionRepository({ adapter, maxQueuedBytes: 4096 });

		const winner = await repository.appendWithExpectedHead(appendInput(event("winner", "base"), "version-winner"));
		const loser = await repository.appendWithExpectedHead(appendInput(event("loser", "base"), "version-loser"));
		const repeated = await repository.appendWithExpectedHead(appendInput(event("loser", "base"), "version-loser"));

		expect(winner.status).toBe("appended");
		expect(winner.branchId).toBe("main");
		expect(loser.status).toBe("forked");
		expect(loser.branchId).toStartWith("branch_");
		expect(repeated.status).toBe("idempotent");
		expect(repeated.branchId).toBe(loser.branchId);
		expect(adapter.branches.get("main")?.head_hash).toBe("winner");
		expect(adapter.branches.get(loser.branchId)?.head_hash).toBe("loser");
		expect(adapter.branches.get(loser.branchId)?.fork_point_hash).toBe("base");
	});

	it("rejects stale mode generations before any branch mutation", async () => {
		const adapter = new MemoryRuntimeAdapter();
		const repository = new TursoSessionRepository({ adapter });
		const input = appendInput(event("stale", "base"), "version-stale");
		input.fence = { ...FENCE, generation: FENCE.generation - 1 };

		await expect(repository.appendWithExpectedHead(input)).rejects.toThrow("stale mode generation");
		expect(adapter.branches.get("main")?.head_hash).toBe("base");
		expect(adapter.events.has("stale")).toBe(false);
	});

	it("commits a contiguous append batch in one fenced transaction", async () => {
		const adapter = new MemoryRuntimeAdapter();
		const repository = new TursoSessionRepository({ adapter });
		const first = event("batch-1", "base");
		const second = event("batch-2", "batch-1");
		const result = await repository.appendWithExpectedHead({
			...appendInput(first, "version-batch"),
			entries: [first, second],
		});

		expect(result.status).toBe("appended");
		expect(result.headHash).toBe("batch-2");
		expect(adapter.branches.get("main")?.head_hash).toBe("batch-2");
		expect(adapter.transactionCount).toBe(1);
	});

	it("keys checkpoints by exact ancestry, metadata, builder and context hash", async () => {
		const adapter = new MemoryRuntimeAdapter();
		const repository = new TursoSessionRepository({ adapter });
		const checkpoint = await repository.putCheckpoint({
			fence: FENCE,
			branchId: "main",
			headHash: "base",
			metadataRevisionId: "meta-a",
			contextBuilderVersion: "builder-v3",
			contextHash: "context-a",
			payloadId: "checkpoint-payload",
			createdAt: NOW,
		});

		expect(checkpoint.checkpoint_key).toBe(
			checkpointKey({
				branchId: "main",
				headHash: "base",
				metadataRevisionId: "meta-a",
				contextBuilderVersion: "builder-v3",
				contextHash: "context-a",
			}),
		);
		expect(await repository.getCheckpoint({
			branchId: "main",
			headHash: "base",
			metadataRevisionId: "meta-a",
			contextBuilderVersion: "builder-v3",
			contextHash: "context-a",
		})).toEqual(checkpoint);
		expect(checkpoint.checkpoint_key).not.toBe(
			checkpointKey({
				branchId: "main",
				headHash: "base",
				metadataRevisionId: "meta-b",
				contextBuilderVersion: "builder-v3",
				contextHash: "context-a",
			}),
		);
	});

	it("returns an fsynced receipt tied to the persisted mode fence", async () => {
		const repository = new TursoSessionRepository({ adapter: new MemoryRuntimeAdapter() });
		const receipt = await repository.flush(FENCE);
		expect(receipt).toMatchObject({ ...FENCE, fsynced: true, checkpointed: true });
		await expect(repository.flush({ ...FENCE, token: "stale" })).rejects.toThrow("stale mode generation");
	});
});

describe("TursoSessionRepository bounded reads", () => {
	it("uses keyset pages and never asks the adapter to materialize a full tree", async () => {
		const adapter = new MemoryRuntimeAdapter();
		for (let index = 0; index < 11; index += 1) {
			const id = index.toString().padStart(2, "0");
			adapter.listRows.push({ ...adapter.headerFor(`branch-${id}`, `version-${id}`, "meta"), sort_key: id });
			adapter.treeRows.push({
				...eventRef(event(`event-${id}`, index === 0 ? null : `event-${(index - 1).toString().padStart(2, "0")}`)),
				depth: index,
				sort_key: id,
			});
			adapter.searchRows.push({
				event_hash: `event-${id}`,
				origin_id: "origin-a",
				branch_id: `branch-${id}`,
				snippet: `needle ${id}`,
				rank: index,
				timestamp: NOW,
				payload_id: `payload-${id}`,
				sort_key: id,
			});
		}
		const repository = new TursoSessionRepository({ adapter, defaultPageSize: 3, maxPageSize: 4 });
		const first = await repository.listSessions({ limit: 3 });
		const second = await repository.listSessions({ limit: 3, cursor: first.nextCursor });
		const tree = await repository.readTree({ branchId: "main", limit: 4 });
		const searchFirst = await repository.search({ text: "needle", limit: 2 });
		const searchSecond = await repository.search({ text: "needle", limit: 2, cursor: searchFirst.nextCursor });

		expect(first.items.map(row => row.sort_key)).toEqual(["00", "01", "02"]);
		expect(second.items.map(row => row.sort_key)).toEqual(["03", "04", "05"]);
		expect(searchFirst.items.map(row => row.sort_key)).toEqual(["00", "01"]);
		expect(searchSecond.items.map(row => row.sort_key)).toEqual(["02", "03"]);
		expect(tree.items).toHaveLength(4);
		expect(tree.nextCursor).toBeDefined();
		expect(adapter.observedLimits.list).toEqual([4, 4]);
		expect(adapter.observedLimits.search).toEqual([3, 3]);
		expect(adapter.observedLimits.tree).toEqual([5]);
	});

	it("keeps payload hydration lazy and streams giant payloads in bounded chunks", async () => {
		const adapter = new MemoryRuntimeAdapter();
		const giant = new Uint8Array(1024 * 1024 + 17).fill(23);
		adapter.payloads.set("giant", giant);
		adapter.listRows.push({ ...adapter.headerFor("main", "version-base", "meta"), sort_key: "00" });
		const repository = new TursoSessionRepository({ adapter, payloadChunkBytes: 64 * 1024 });

		await repository.listSessions();
		expect(adapter.payloadStreamStarted).toBe(false);
		const chunks: Uint8Array[] = [];
		for await (const chunk of repository.readPayload({ payloadId: "giant" })) chunks.push(chunk);
		expect(chunks.length).toBe(17);
		expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBe(64 * 1024);
		expect(chunks.reduce((size, chunk) => size + chunk.byteLength, 0)).toBe(giant.byteLength);
	});

	it("reads only a bounded selected ancestry tail and returns chronological refs", async () => {
		const adapter = new MemoryRuntimeAdapter();
		for (let index = 1; index <= 5; index += 1) {
			const value = event(`e${index}`, index === 1 ? "base" : `e${index - 1}`);
			adapter.events.set(value.event_hash, value);
		}
		adapter.branches.set("main", { ...adapter.branches.get("main")!, head_hash: "e5" });
		const repository = new TursoSessionRepository({ adapter, maxPageSize: 3 });
		const tail = await repository.readContextTail({ branchId: "main", limit: 3 });
		expect(tail.map(value => value.event_hash)).toEqual(["e3", "e4", "e5"]);
		expect(adapter.observedLimits.tail).toEqual([3]);
	});
});

describe("ByteBoundedWriterQueue", () => {
	it("backpressures by retained bytes and cancels a producer waiting for capacity", async () => {
		const queue = new ByteBoundedWriterQueue(5);
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>(resolve => (markFirstStarted = resolve));
		const first = queue.enqueue(
			5,
			() =>
				new Promise<void>(resolve => {
					releaseFirst = resolve;
					markFirstStarted();
				}),
		);
		await firstStarted;
		const controller = new AbortController();
		let secondRan = false;
		const second = queue.enqueue(
			1,
			() => {
				secondRan = true;
			},
			{ signal: controller.signal },
		);
		expect(queue.stats).toMatchObject({ usedBytes: 5, waitingProducers: 1, running: true });
		controller.abort(new Error("cancelled while backpressured"));
		await expect(second).rejects.toThrow("cancelled while backpressured");
		expect(secondRan).toBe(false);
		releaseFirst();
		await first;
		await queue.flush();
		expect(queue.stats).toMatchObject({ usedBytes: 0, waitingProducers: 0, queuedTasks: 0, running: false });
	});

	it("rejects a batch larger than its byte bound", async () => {
		const queue = new ByteBoundedWriterQueue(8);
		await expect(queue.enqueue(9, () => undefined)).rejects.toThrow("exceeding the 8-byte queue limit");
	});
});

function eventRef(value: DbEventInput): DbEventRef {
	return {
		event_hash: value.event_hash,
		origin_id: value.origin_id,
		parent_hash: value.parent_hash,
		native_entry_id: value.native_entry_id,
		kind: value.kind,
		timestamp: value.timestamp,
		payload_id: value.payload.payload_id,
		payload_bytes: value.payload.uncompressed_bytes,
	};
}
