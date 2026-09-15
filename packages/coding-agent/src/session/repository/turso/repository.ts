import { decodeKeyset, keysetPage, normalizePageSize, type KeysetPage, type KeysetPosition } from "./pagination";
import { ByteBoundedWriterQueue, type WriterQueueStats } from "./worker-queue";

export interface DbPayloadInput {
	payload_id: string;
	content_hash: string;
	codec: string;
	uncompressed_bytes: number;
	bytes: Uint8Array;
}

export interface DbEventInput {
	event_hash: string;
	origin_id: string;
	parent_hash: string | null;
	native_entry_id: string;
	kind: string;
	timestamp: string;
	payload: DbPayloadInput;
	canonicalizer_version: string;
}

export interface DbEventRef {
	event_hash: string;
	origin_id: string;
	parent_hash: string | null;
	native_entry_id: string;
	kind: string;
	timestamp: string;
	payload_id: string;
	payload_bytes: number;
}

export interface DbBranchRow {
	branch_id: string;
	origin_id: string;
	parent_branch_id: string | null;
	fork_point_hash: string | null;
	head_hash: string | null;
	head_version_id: string | null;
	generation: number;
}

export interface DbVersionInput {
	version_id: string;
	origin_id: string;
	branch_id: string;
	parent_version_id: string | null;
	head_hash: string;
	metadata_revision_id: string;
	created_at: string;
}

export interface DbSessionHeader {
	origin_id: string;
	branch_id: string;
	version_id: string;
	head_hash: string | null;
	generation: number;
	title?: string;
	created_at: string;
	updated_at: string;
	metadata_revision_id: string;
}

export interface DbSessionListRow extends DbSessionHeader {
	/** Adapter-normalized ordering value (for example inverted timestamp + id). */
	sort_key: string;
}

export interface DbSearchHit {
	event_hash: string;
	origin_id: string;
	branch_id: string;
	snippet: string;
	rank: number;
	timestamp: string;
	payload_id: string;
	/** Adapter-normalized rank/time ordering value. */
	sort_key: string;
}

export interface DbTreeRow extends DbEventRef {
	depth: number;
	sort_key: string;
}

export interface DbCheckpoint {
	checkpoint_key: string;
	branch_id: string;
	head_hash: string;
	metadata_revision_id: string;
	context_builder_version: string;
	context_hash: string;
	payload_id: string;
	created_at: string;
}

export interface DbHealth {
	ok: boolean;
	writable: boolean;
	schemaVersion: number;
	message?: string;
	details?: Readonly<Record<string, unknown>>;
}

/** Persisted mode generation checked in the same transaction as every write. */
export interface StorageGenerationFence {
	replica_id: string;
	generation: number;
	token: string;
}

/**
 * Receipt proving all commits preceding `committed_sequence` crossed the
 * embedded engine's durable commit/fsync boundary.
 */
export interface DurableFlushReceipt extends StorageGenerationFence {
	committed_sequence: string;
	fsynced: true;
	checkpointed: boolean;
}

export interface TursoRuntimeReadAdapter {
	listBranches(query: {
		after?: KeysetPosition;
		limit: number;
		origin_id?: string;
	}): Promise<readonly DbSessionListRow[]>;
	searchEvents(query: {
		text: string;
		after?: KeysetPosition;
		limit: number;
		origin_id?: string;
		branch_id?: string;
		signal?: AbortSignal;
	}): Promise<readonly DbSearchHit[]>;
	readTreePage(query: {
		branch_id: string;
		after?: KeysetPosition;
		limit: number;
		head_hash?: string;
		signal?: AbortSignal;
	}): Promise<readonly DbTreeRow[]>;
	getHeader(branch_id: string): Promise<DbSessionHeader | undefined>;
	readAncestryTail(query: {
		branch_id: string;
		head_hash?: string;
		limit: number;
		signal?: AbortSignal;
	}): Promise<readonly DbEventRef[]>;
	streamPayloadChunks(query: {
		payload_id: string;
		chunk_bytes: number;
		signal?: AbortSignal;
	}): AsyncIterable<Uint8Array>;
	getCheckpoint(checkpoint_key: string): Promise<DbCheckpoint | undefined>;
	health(): Promise<DbHealth>;
	/**
	 * Drains prepared statements, commits the engine transaction log, performs
	 * the pinned engine's supported fsync/checkpoint procedure, then returns its
	 * persisted generation and durable sequence. It must reject a stale fence.
	 */
	flush(fence: StorageGenerationFence): Promise<DurableFlushReceipt>;
	close(): Promise<void>;
}

export interface TursoRuntimeTransaction {
	/** Must read and compare the persisted generation row inside this transaction. */
	assertModeGeneration(fence: StorageGenerationFence): Promise<void>;
	getBranch(branch_id: string): Promise<DbBranchRow | undefined>;
	isEventReachable(branch_id: string, event_hash: string | null): Promise<boolean>;
	insertImmutablePayloads(payloads: readonly DbPayloadInput[]): Promise<void>;
	insertImmutableEvents(events: readonly DbEventInput[]): Promise<void>;
	/**
	 * A prepared CAS update plus version insert. It must return false without
	 * retaining the supplied version when the expected head no longer matches.
	 */
	tryAdvanceBranch(input: {
		branch_id: string;
		expected_head_hash: string | null;
		new_head_hash: string;
		version: DbVersionInput;
	}): Promise<boolean>;
	/** Idempotently inserts the branch and its immutable selected version. */
	ensureBranch(input: { branch: DbBranchRow; version: DbVersionInput }): Promise<void>;
	putCheckpoint(checkpoint: DbCheckpoint): Promise<void>;
}

/**
 * Narrow bridge implemented by the pinned embedded-Turso engine lane. SQL and
 * prepared statement details stay on that side; this runtime never accepts a
 * filesystem path and cannot fall through to JSONL storage.
 */
export interface TursoRuntimeAdapter extends TursoRuntimeReadAdapter {
	transaction<T>(work: (tx: TursoRuntimeTransaction) => Promise<T>): Promise<T>;
}

export interface TursoSessionRepositoryOptions {
	adapter: TursoRuntimeAdapter;
	maxQueuedBytes?: number;
	maxPageSize?: number;
	defaultPageSize?: number;
	payloadChunkBytes?: number;
}

export interface AppendWithExpectedHeadInput {
	fence: StorageGenerationFence;
	originId: string;
	branchId: string;
	expectedHeadHash: string | null;
	parentVersionId: string | null;
	versionId: string;
	metadataRevisionId: string;
	createdAt: string;
	entries: readonly DbEventInput[];
	signal?: AbortSignal;
}

export interface AppendResult {
	status: "appended" | "forked" | "idempotent";
	branchId: string;
	headHash: string;
	previousHeadHash: string | null;
	header: DbSessionHeader;
}

export interface ListSessionsQuery {
	cursor?: string;
	limit?: number;
	originId?: string;
}

export interface SearchQuery {
	text: string;
	cursor?: string;
	limit?: number;
	originId?: string;
	branchId?: string;
	signal?: AbortSignal;
}

export interface ReadTreeQuery {
	branchId: string;
	headHash?: string;
	cursor?: string;
	limit?: number;
	signal?: AbortSignal;
}

export interface ForkInput {
	fence: StorageGenerationFence;
	branchId: string;
	forkPointHash: string | null;
	newBranchId?: string;
	versionId: string;
	metadataRevisionId: string;
	createdAt: string;
	parentVersionId: string | null;
	signal?: AbortSignal;
}

export interface PutCheckpointInput {
	fence: StorageGenerationFence;
	branchId: string;
	headHash: string;
	metadataRevisionId: string;
	contextBuilderVersion: string;
	contextHash: string;
	payloadId: string;
	createdAt: string;
	signal?: AbortSignal;
}

export interface RepositoryHealth extends DbHealth {
	queue: WriterQueueStats;
}

const textEncoder = new TextEncoder();
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAYLOAD_CHUNK_BYTES = 64 * 1024;

export class TursoSessionRepository {
	readonly #adapter: TursoRuntimeAdapter;
	readonly #writers: ByteBoundedWriterQueue;
	readonly #defaultPageSize: number;
	readonly #maxPageSize: number;
	readonly #payloadChunkBytes: number;
	#closed = false;

	constructor(options: TursoSessionRepositoryOptions) {
		this.#adapter = options.adapter;
		this.#writers = new ByteBoundedWriterQueue(options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES);
		this.#maxPageSize = options.maxPageSize ?? 500;
		this.#defaultPageSize = options.defaultPageSize ?? Math.min(100, this.#maxPageSize);
		this.#payloadChunkBytes = options.payloadChunkBytes ?? DEFAULT_PAYLOAD_CHUNK_BYTES;
		normalizePageSize(undefined, { defaultSize: this.#defaultPageSize, maxSize: this.#maxPageSize });
		if (!Number.isSafeInteger(this.#payloadChunkBytes) || this.#payloadChunkBytes < 1) {
			throw new RangeError("payloadChunkBytes must be a positive integer");
		}
	}

	async listSessions(query: ListSessionsQuery = {}): Promise<KeysetPage<DbSessionListRow>> {
		this.#assertOpen();
		const limit = this.#pageSize(query.limit);
		const rows = await this.#adapter.listBranches({
			after: decodeKeyset(query.cursor),
			limit: limit + 1,
			origin_id: query.originId,
		});
		return keysetPage(rows, limit, row => ({ sortKey: row.sort_key, id: row.branch_id }));
	}

	async search(query: SearchQuery): Promise<KeysetPage<DbSearchHit>> {
		this.#assertOpen();
		if (query.text.trim().length === 0) throw new Error("search text must not be empty");
		throwIfAborted(query.signal);
		const limit = this.#pageSize(query.limit);
		const rows = await this.#adapter.searchEvents({
			text: query.text,
			after: decodeKeyset(query.cursor),
			limit: limit + 1,
			origin_id: query.originId,
			branch_id: query.branchId,
			signal: query.signal,
		});
		throwIfAborted(query.signal);
		return keysetPage(rows, limit, row => ({ sortKey: row.sort_key, id: `${row.branch_id}:${row.event_hash}` }));
	}

	async readTree(query: ReadTreeQuery): Promise<KeysetPage<DbTreeRow>> {
		this.#assertOpen();
		throwIfAborted(query.signal);
		const limit = this.#pageSize(query.limit);
		const rows = await this.#adapter.readTreePage({
			branch_id: query.branchId,
			head_hash: query.headHash,
			after: decodeKeyset(query.cursor),
			limit: limit + 1,
			signal: query.signal,
		});
		throwIfAborted(query.signal);
		return keysetPage(rows, limit, row => ({ sortKey: row.sort_key, id: row.event_hash }));
	}

	async getHeader(input: { branchId: string }): Promise<DbSessionHeader | undefined> {
		this.#assertOpen();
		return this.#adapter.getHeader(input.branchId);
	}

	async appendWithExpectedHead(input: AppendWithExpectedHeadInput): Promise<AppendResult> {
		this.#assertOpen();
		assertFence(input.fence);
		this.#validateAppend(input);
		const bytes = estimateAppendBytes(input);
		return this.#writers.enqueue(
			bytes,
			async signal => {
				throwIfAborted(signal);
				const outcome = await this.#adapter.transaction(async tx => {
					await tx.assertModeGeneration(input.fence);
					const branch = await tx.getBranch(input.branchId);
					if (!branch) throw new Error(`unknown branch: ${input.branchId}`);
					if (branch.origin_id !== input.originId) throw new Error("append origin does not match branch origin");

					const newHeadHash = input.entries.at(-1)!.event_hash;
					if (branch.head_hash === newHeadHash) {
						return { status: "idempotent" as const, branchId: branch.branch_id, previousHeadHash: branch.head_hash };
					}
					if (!(await tx.isEventReachable(input.branchId, input.expectedHeadHash))) {
						throw new Error("expected head is not known ancestry of the target branch");
					}

					await tx.insertImmutablePayloads(input.entries.map(entry => entry.payload));
					await tx.insertImmutableEvents(input.entries);
					const directVersion: DbVersionInput = {
						version_id: input.versionId,
						origin_id: input.originId,
						branch_id: input.branchId,
						parent_version_id: input.parentVersionId,
						head_hash: newHeadHash,
						metadata_revision_id: input.metadataRevisionId,
						created_at: input.createdAt,
					};

					if (
						branch.head_hash === input.expectedHeadHash &&
						(await tx.tryAdvanceBranch({
							branch_id: input.branchId,
							expected_head_hash: input.expectedHeadHash,
							new_head_hash: newHeadHash,
							version: directVersion,
						}))
					) {
						return { status: "appended" as const, branchId: input.branchId, previousHeadHash: branch.head_hash };
					}

					const siblingId = await deterministicId("branch", [
						input.originId,
						input.branchId,
						input.expectedHeadHash ?? "",
						newHeadHash,
					]);
					const existingSibling = await tx.getBranch(siblingId);
					if (
						existingSibling?.origin_id === input.originId &&
						existingSibling.head_hash === newHeadHash &&
						existingSibling.fork_point_hash === input.expectedHeadHash
					) {
						return { status: "idempotent" as const, branchId: siblingId, previousHeadHash: branch.head_hash };
					}
					await tx.ensureBranch({
						branch: {
							branch_id: siblingId,
							origin_id: input.originId,
							parent_branch_id: input.branchId,
							fork_point_hash: input.expectedHeadHash,
							head_hash: newHeadHash,
							head_version_id: input.versionId,
							generation: 1,
						},
						version: { ...directVersion, branch_id: siblingId },
					});
					return { status: "forked" as const, branchId: siblingId, previousHeadHash: branch.head_hash };
				});
				const header = await this.#adapter.getHeader(outcome.branchId);
				if (!header) throw new Error(`committed branch is missing its header: ${outcome.branchId}`);
				return {
					...outcome,
					headHash: input.entries.at(-1)!.event_hash,
					header,
				};
			},
			{ signal: input.signal },
		);
	}

	async fork(input: ForkInput): Promise<DbSessionHeader> {
		this.#assertOpen();
		assertFence(input.fence);
		throwIfAborted(input.signal);
		const source = await this.#adapter.getHeader(input.branchId);
		if (!source) throw new Error(`unknown branch: ${input.branchId}`);
		if (input.forkPointHash === null) throw new Error("a runtime fork requires a concrete fork point");
		const forkPointHash = input.forkPointHash;
		const newBranchId =
			input.newBranchId ??
			(await deterministicId("branch", [source.origin_id, input.branchId, forkPointHash, input.versionId]));
		const bytes = Math.max(1, textEncoder.encode(JSON.stringify(input)).byteLength);
		await this.#writers.enqueue(
			bytes,
			async signal => {
				throwIfAborted(signal);
				await this.#adapter.transaction(async tx => {
					await tx.assertModeGeneration(input.fence);
					if (!(await tx.isEventReachable(input.branchId, forkPointHash))) {
						throw new Error("fork point is not known ancestry of the source branch");
					}
					await tx.ensureBranch({
						branch: {
							branch_id: newBranchId,
							origin_id: source.origin_id,
							parent_branch_id: input.branchId,
							fork_point_hash: forkPointHash,
							head_hash: forkPointHash,
							head_version_id: input.versionId,
							generation: 1,
						},
						version: {
							version_id: input.versionId,
							origin_id: source.origin_id,
							branch_id: newBranchId,
							parent_version_id: input.parentVersionId,
							head_hash: forkPointHash,
							metadata_revision_id: input.metadataRevisionId,
							created_at: input.createdAt,
						},
					});
				});
			},
			{ signal: input.signal },
		);
		const header = await this.#adapter.getHeader(newBranchId);
		if (!header) throw new Error(`committed fork is missing its header: ${newBranchId}`);
		return header;
	}

	async putCheckpoint(input: PutCheckpointInput): Promise<DbCheckpoint> {
		this.#assertOpen();
		assertFence(input.fence);
		throwIfAborted(input.signal);
		const checkpoint: DbCheckpoint = {
			checkpoint_key: checkpointKey(input),
			branch_id: input.branchId,
			head_hash: input.headHash,
			metadata_revision_id: input.metadataRevisionId,
			context_builder_version: input.contextBuilderVersion,
			context_hash: input.contextHash,
			payload_id: input.payloadId,
			created_at: input.createdAt,
		};
		const bytes = Math.max(1, textEncoder.encode(JSON.stringify(checkpoint)).byteLength);
		await this.#writers.enqueue(
			bytes,
			async signal => {
				throwIfAborted(signal);
				await this.#adapter.transaction(async tx => {
					await tx.assertModeGeneration(input.fence);
					if (!(await tx.isEventReachable(input.branchId, input.headHash))) {
						throw new Error("checkpoint head is not known ancestry of the branch");
					}
					await tx.putCheckpoint(checkpoint);
				});
			},
			{ signal: input.signal },
		);
		return checkpoint;
	}

	async getCheckpoint(
		input: Omit<PutCheckpointInput, "fence" | "payloadId" | "createdAt" | "signal">,
	): Promise<DbCheckpoint | undefined> {
		this.#assertOpen();
		return this.#adapter.getCheckpoint(checkpointKey(input));
	}

	async readContextTail(input: {
		branchId: string;
		headHash?: string;
		limit?: number;
		signal?: AbortSignal;
	}): Promise<readonly DbEventRef[]> {
		this.#assertOpen();
		throwIfAborted(input.signal);
		const limit = normalizePageSize(input.limit, {
			defaultSize: Math.min(500, this.#maxPageSize),
			maxSize: this.#maxPageSize,
		});
		const newestFirst = await this.#adapter.readAncestryTail({
			branch_id: input.branchId,
			head_hash: input.headHash,
			limit,
			signal: input.signal,
		});
		if (newestFirst.length > limit) throw new Error(`adapter returned more than the ${limit}-entry context bound`);
		throwIfAborted(input.signal);
		return newestFirst.slice().reverse();
	}

	async *readPayload(input: { payloadId: string; signal?: AbortSignal }): AsyncIterable<Uint8Array> {
		this.#assertOpen();
		throwIfAborted(input.signal);
		for await (const chunk of this.#adapter.streamPayloadChunks({
			payload_id: input.payloadId,
			chunk_bytes: this.#payloadChunkBytes,
			signal: input.signal,
		})) {
			throwIfAborted(input.signal);
			if (chunk.byteLength > this.#payloadChunkBytes) {
				throw new Error(`adapter emitted a ${chunk.byteLength}-byte payload chunk above the configured bound`);
			}
			yield chunk;
		}
	}

	async flush(fence: StorageGenerationFence): Promise<DurableFlushReceipt> {
		this.#assertOpen();
		assertFence(fence);
		await this.#writers.flush();
		const receipt = await this.#adapter.flush(fence);
		if (
			receipt.replica_id !== fence.replica_id ||
			receipt.generation !== fence.generation ||
			receipt.token !== fence.token ||
			receipt.fsynced !== true
		) {
			throw new Error("embedded Turso flush did not return a matching durable fencing receipt");
		}
		return receipt;
	}

	async health(): Promise<RepositoryHealth> {
		this.#assertOpen();
		const engine = await this.#adapter.health();
		const queue = this.#writers.stats;
		return {
			...engine,
			ok: engine.ok && queue.failedTasks === 0,
			message: queue.lastError === undefined ? engine.message : engine.message ?? "writer queue observed a failed operation",
			queue,
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#writers.close();
		// Accepted mutations already crossed their transactional generation
		// checks. Callers must explicitly flush with a live fence before close.
		await this.#adapter.close();
	}

	#pageSize(requested: number | undefined): number {
		return normalizePageSize(requested, { defaultSize: this.#defaultPageSize, maxSize: this.#maxPageSize });
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Turso session repository is closed");
	}

	#validateAppend(input: AppendWithExpectedHeadInput): void {
		if (input.entries.length === 0) throw new Error("append requires at least one entry");
		let parent = input.expectedHeadHash;
		for (const entry of input.entries) {
			if (entry.origin_id !== input.originId) throw new Error("entry origin does not match append origin");
			if (entry.parent_hash !== parent) throw new Error("append entries must form a contiguous chain from expected head");
			if (entry.payload.bytes.byteLength !== entry.payload.uncompressed_bytes && entry.payload.codec === "identity") {
				throw new Error("identity payload byte length does not match declared length");
			}
			parent = entry.event_hash;
		}
	}
}

/**
 * Public runtime seam. The caller supplies an already-open DB adapter, so
 * importing this module never loads a native driver and JSONL startup remains
 * independent of `@tursodatabase/database`.
 */
export function createTursoSessionRepository(options: TursoSessionRepositoryOptions): TursoSessionRepository {
	return new TursoSessionRepository(options);
}

export function checkpointKey(input: {
	branchId: string;
	headHash: string;
	metadataRevisionId: string;
	contextBuilderVersion: string;
	contextHash: string;
}): string {
	const fields = [
		input.branchId,
		input.headHash,
		input.metadataRevisionId,
		input.contextBuilderVersion,
		input.contextHash,
	];
	return fields.map(field => `${textEncoder.encode(field).byteLength}:${field}`).join("|");
}

function estimateAppendBytes(input: AppendWithExpectedHeadInput): number {
	let bytes = 1;
	for (const entry of input.entries) {
		bytes += entry.payload.bytes.byteLength;
		bytes +=
			3 *
			(entry.event_hash.length +
				entry.origin_id.length +
				(entry.parent_hash?.length ?? 0) +
				entry.native_entry_id.length +
				entry.kind.length +
				entry.timestamp.length +
				entry.payload.payload_id.length +
				entry.payload.content_hash.length +
				entry.payload.codec.length +
				entry.canonicalizer_version.length);
	}
	return bytes;
}

async function deterministicId(prefix: string, fields: readonly string[]): Promise<string> {
	const framed = fields.map(field => `${textEncoder.encode(field).byteLength}:${field}`).join("|");
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(`${prefix}\0${framed}`)));
	return `${prefix}_${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function assertFence(fence: StorageGenerationFence): void {
	if (
		fence.replica_id.length === 0 ||
		!Number.isSafeInteger(fence.generation) ||
		fence.generation < 0 ||
		fence.token.length === 0
	) {
		throw new Error("invalid persisted mode-generation fence");
	}
}
