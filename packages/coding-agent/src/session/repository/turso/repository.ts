import { canonicalSerialize } from "../canonical";
import { computeBranchIdentity, computeOriginIdentity, computeSourceAlias } from "../identity";
import type {
	AppendWithExpectedHeadRequest,
	AppendWithExpectedHeadResult,
	BranchId,
	CreateSessionRequest,
	ConsumeDraftRequest,
	DropSessionRequest,
	EventHash,
	FlushRequest,
	ForkRequest,
	GetHeaderRequest,
	KeysetCursor,
	KeysetPage,
	ListSessionsQuery,
	ListRelatedResourcesQuery,
	ModeGeneration,
	OriginId,
	PayloadDescriptor,
	ReadContextTailRequest,
	ReadEventsQuery,
	ReadPayloadRequest,
	ReadTreeQuery,
	RegisterRelatedResourceRequest,
	RelatedResourceBinding,
	RelatedResourceLocator,
	SourceAlias,
	RelocateSessionRequest,
	ReplicaId,
	RepositoryCapabilities,
	RepositoryEvent,
	RepositoryHealth,
	RepositorySessionHeader,
	RepositoryTreeNode,
	SaveDraftRequest,
	SearchSessionsQuery,
	SessionDraft,
	SessionLocator,
	SessionRepository,
	SessionSearchHit,
	SetSessionPinnedRequest,
	SetTerminalSessionPointerRequest,
	TerminalSessionPointer,
	UpdateSessionTitleRequest,
	WriteCheckpointRequest,
	WritePayloadRequest,
} from "../types";
import { decodeKeyset, keysetPage, normalizePageSize, type KeysetPosition } from "./pagination";
import { ByteBoundedWriterQueue, type WriterQueueStats } from "./worker-queue";

/** A domain value plus its stable adapter-owned keyset position. */
export interface TursoKeysetRow<T> {
	readonly value: T;
	readonly position: KeysetPosition;
}

export interface TursoPageRequest {
	readonly after?: KeysetPosition;
	readonly limit: number;
}

export interface TursoAppendMutation {
	readonly request: AppendWithExpectedHeadRequest;
	readonly targetBranchId: BranchId;
	readonly parentBranchId: BranchId | null;
	readonly forkPointHash: EventHash | null;
}

export interface TursoAppendMutationResult {
	readonly header: RepositorySessionHeader;
	readonly changed: boolean;
}

export interface TursoForkMutation {
	readonly request: ForkRequest;
	readonly targetBranchId: BranchId;
}

export interface TursoCreateMutation {
	readonly request: CreateSessionRequest;
	readonly originId: OriginId;
	readonly sourceAlias: SourceAlias;
	readonly targetBranchId: BranchId;
}

/**
 * Transactional publishing surface implemented by the embedded-engine adapter.
 * `assertModeGeneration` must read the persisted fence in this same transaction.
 */
export interface TursoRuntimeTransaction {
	assertModeGeneration(expected: ModeGeneration): Promise<void>;
	getHeader(branchId: BranchId): Promise<RepositorySessionHeader | undefined>;
	isEventReachable(branchId: BranchId, eventHash: EventHash | null): Promise<boolean>;
	createSession(mutation: TursoCreateMutation): Promise<RepositorySessionHeader>;
	append(mutation: TursoAppendMutation): Promise<TursoAppendMutationResult>;
	fork(mutation: TursoForkMutation): Promise<RepositorySessionHeader>;
	/**
	 * Applies a metadata-only version at expectedHeadHash. A lost CAS is retained
	 * as a sibling version from that head rather than merged with current metadata.
	 */
	updateTitle(request: UpdateSessionTitleRequest): Promise<RepositorySessionHeader>;
	drop(request: DropSessionRequest): Promise<boolean>;
	relocate(request: RelocateSessionRequest): Promise<SessionLocator>;
	saveDraft(request: SaveDraftRequest): Promise<SessionDraft>;
	consumeDraft(request: ConsumeDraftRequest): Promise<SessionDraft | undefined>;
	registerRelatedResource(request: RegisterRelatedResourceRequest): Promise<void>;
	setTerminalSessionPointer(request: SetTerminalSessionPointerRequest): Promise<void>;
	setPinned(request: SetSessionPinnedRequest): Promise<void>;
	putCheckpoint(request: WriteCheckpointRequest): Promise<void>;
}

export interface TursoDurableFlushReceipt {
	readonly modeGeneration: ModeGeneration;
	readonly durable: true;
	readonly committedSequence: string;
	readonly checkpointed: boolean;
}

export interface TursoRuntimeHealth {
	readonly status: "ok" | "degraded" | "unavailable";
	readonly modeGeneration: ModeGeneration;
	readonly writable: boolean;
	readonly details?: readonly string[];
}

/**
 * Narrow DB runtime bridge. It accepts logical identifiers and domain values,
 * never JSONL/session paths or archive/filesystem services.
 */
export interface TursoRuntimeAdapter {
	readonly replicaId: ReplicaId;
	transaction<T>(work: (transaction: TursoRuntimeTransaction) => Promise<T>): Promise<T>;
	listSessions(
		query: TursoPageRequest & Pick<ListSessionsQuery, "originId" | "sourceAlias">,
	): Promise<readonly TursoKeysetRow<RepositorySessionHeader>[]>;
	search(
		query: TursoPageRequest & Pick<SearchSessionsQuery, "text" | "originId">,
	): Promise<readonly TursoKeysetRow<SessionSearchHit>[]>;
	readTree(
		query: TursoPageRequest & Pick<ReadTreeQuery, "branchId">,
	): Promise<readonly TursoKeysetRow<RepositoryTreeNode>[]>;
	readEvents(
		query: TursoPageRequest & Pick<ReadEventsQuery, "branchId" | "versionId">,
	): Promise<readonly TursoKeysetRow<RepositoryEvent>[]>;
	listRelatedResources(
		query: TursoPageRequest & Pick<ListRelatedResourcesQuery, "owner" | "kind">,
	): Promise<readonly TursoKeysetRow<RelatedResourceBinding>[]>;
	getHeader(branchId: BranchId): Promise<RepositorySessionHeader | undefined>;
	readContextTail(query: {
		branchId: BranchId;
		afterEventHash?: EventHash;
		limit: number;
	}): AsyncIterable<RepositoryEvent>;
	writePayload(request: WritePayloadRequest): Promise<PayloadDescriptor>;
	readPayload(query: { payloadHash: ReadPayloadRequest["payloadHash"]; chunkBytes: number }): AsyncIterable<Uint8Array>;
	resolveRelatedResource(locator: RelatedResourceLocator): Promise<SessionLocator | undefined>;
	getTerminalSessionPointer(terminalId: string): Promise<TerminalSessionPointer | undefined>;
	listPinned(limit: number): Promise<readonly BranchId[]>;
	flush(expectedModeGeneration: ModeGeneration): Promise<TursoDurableFlushReceipt>;
	health(): Promise<TursoRuntimeHealth>;
	close(): Promise<void>;
}

export interface TursoSessionRepositoryOptions {
	adapter: TursoRuntimeAdapter;
	maxQueuedBytes?: number;
	maxPageSize?: number;
	defaultPageSize?: number;
	payloadChunkBytes?: number;
	maxPayloadChunkBytes?: number;
	maxPinnedResults?: number;
}

export interface TursoRepositoryHealth extends RepositoryHealth {
	readonly queue: WriterQueueStats;
}

const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAYLOAD_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_PAYLOAD_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_PINNED_RESULTS = 10_000;
const encoder = new TextEncoder();

/** Authoritative database implementation of the domain SessionRepository. */
export class TursoSessionRepository implements SessionRepository {
	readonly mode = "db" as const;
	readonly replicaId: ReplicaId;
	readonly #adapter: TursoRuntimeAdapter;
	readonly #writers: ByteBoundedWriterQueue;
	readonly #defaultPageSize: number;
	readonly #maxPageSize: number;
	readonly #payloadChunkBytes: number;
	readonly #maxPayloadChunkBytes: number;
	readonly #maxPinnedResults: number;
	#closed = false;

	constructor(options: TursoSessionRepositoryOptions) {
		this.#adapter = options.adapter;
		this.replicaId = options.adapter.replicaId;
		this.#writers = new ByteBoundedWriterQueue(options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES);
		this.#maxPageSize = options.maxPageSize ?? 500;
		this.#defaultPageSize = options.defaultPageSize ?? Math.min(100, this.#maxPageSize);
		this.#payloadChunkBytes = options.payloadChunkBytes ?? DEFAULT_PAYLOAD_CHUNK_BYTES;
		this.#maxPayloadChunkBytes = options.maxPayloadChunkBytes ?? DEFAULT_MAX_PAYLOAD_CHUNK_BYTES;
		this.#maxPinnedResults = options.maxPinnedResults ?? DEFAULT_MAX_PINNED_RESULTS;
		normalizePageSize(undefined, { defaultSize: this.#defaultPageSize, maxSize: this.#maxPageSize });
		assertPositiveInteger(this.#payloadChunkBytes, "payloadChunkBytes");
		assertPositiveInteger(this.#maxPayloadChunkBytes, "maxPayloadChunkBytes");
		assertPositiveInteger(this.#maxPinnedResults, "maxPinnedResults");
		if (this.#payloadChunkBytes > this.#maxPayloadChunkBytes) {
			throw new RangeError("payloadChunkBytes exceeds maxPayloadChunkBytes");
		}
	}

	capabilities(): RepositoryCapabilities {
		return {
			keysetPagination: true,
			streamingPayloads: true,
			expectedHeadCas: true,
			siblingForkOnConflict: true,
			modeGenerationFencing: true,
		};
	}

	async listSessions(query: ListSessionsQuery = {}): Promise<KeysetPage<RepositorySessionHeader>> {
		this.#assertOpen();
		const limit = this.#pageSize(query.limit);
		return this.#page(
			await this.#adapter.listSessions({
				after: decodeKeyset(query.cursor),
				limit: limit + 1,
				originId: query.originId,
				sourceAlias: query.sourceAlias,
			}),
			limit,
		);
	}

	async search(query: SearchSessionsQuery): Promise<KeysetPage<SessionSearchHit>> {
		this.#assertOpen();
		if (query.text.trim().length === 0) throw new TypeError("search text must not be empty");
		const limit = this.#pageSize(query.limit);
		return this.#page(
			await this.#adapter.search({
				after: decodeKeyset(query.cursor),
				limit: limit + 1,
				text: query.text,
				originId: query.originId,
			}),
			limit,
		);
	}

	async readTree(query: ReadTreeQuery): Promise<KeysetPage<RepositoryTreeNode>> {
		this.#assertOpen();
		const limit = this.#pageSize(query.limit);
		return this.#page(
			await this.#adapter.readTree({
				after: decodeKeyset(query.cursor),
				limit: limit + 1,
				branchId: query.branchId,
			}),
			limit,
		);
	}

	async readEvents(query: ReadEventsQuery): Promise<KeysetPage<RepositoryEvent>> {
		this.#assertOpen();
		const limit = this.#pageSize(query.limit);
		return this.#page(
			await this.#adapter.readEvents({
				after: decodeKeyset(query.cursor),
				limit: limit + 1,
				branchId: query.branchId,
				versionId: query.versionId,
			}),
			limit,
		);
	}

	async getHeader(request: GetHeaderRequest): Promise<RepositorySessionHeader | undefined> {
		this.#assertOpen();
		return this.#adapter.getHeader(request.branchId);
	}

	async createSession(request: CreateSessionRequest): Promise<RepositorySessionHeader> {
		if (request.callerKey.length === 0) throw new TypeError("Session caller key must not be empty");
		if (request.header.type !== "session") throw new TypeError("Session header type must be session");
		if (request.header.id !== request.source.nativeId) {
			throw new Error("Session header id must match the source native id");
		}
		const originId = computeOriginIdentity(request.source).id;
		const sourceAlias = computeSourceAlias(request.source).id;
		const targetBranchId = computeBranchIdentity({
			originId,
			replicaId: this.replicaId,
			branchKey: `create:${request.callerKey}`,
		}).id;
		return this.#enqueueWrite(request, async transaction => {
			const existing = await transaction.getHeader(targetBranchId);
			if (existing) {
				assertCommittedHeader(existing, targetBranchId, originId);
				if (existing.sourceAlias !== sourceAlias) {
					throw new Error("Stable session caller key resolved to conflicting identity");
				}
				return existing;
			}
			const header = await transaction.createSession({
				request,
				originId,
				sourceAlias,
				targetBranchId,
			});
			assertCommittedHeader(header, targetBranchId, originId);
			if (header.sourceAlias !== sourceAlias) throw new Error("adapter changed the session source alias");
			return header;
		});
	}

	async appendWithExpectedHead(request: AppendWithExpectedHeadRequest): Promise<AppendWithExpectedHeadResult> {
		this.#assertOpen();
		return this.#enqueueWrite(request, async transaction => {
			const current = await transaction.getHeader(request.branchId);
			if (!current) throw new Error(`Unknown branch ${request.branchId}`);
			if (!(await transaction.isEventReachable(request.branchId, request.expectedHeadHash))) {
				throw new Error("Expected head is not in branch ancestry");
			}
			const lostCas = current.headEventHash !== request.expectedHeadHash;
			const targetBranchId = lostCas
				? computeBranchIdentity({
						originId: current.originId,
						replicaId: this.replicaId,
						branchKey: `cas:${current.branchId}:${request.expectedHeadHash ?? "root"}:${appendFingerprint(request)}`,
					}).id
				: current.branchId;
			const result = await transaction.append({
				request,
				targetBranchId,
				parentBranchId: lostCas ? current.branchId : null,
				forkPointHash: lostCas ? request.expectedHeadHash : current.forkPointHash,
			});
			assertCommittedHeader(result.header, targetBranchId, current.originId);
			if (lostCas) {
				return { status: "forked", header: result.header, conflictedBranchId: current.branchId };
			}
			return { status: result.changed ? "appended" : "idempotent", header: result.header };
		});
	}

	async fork(request: ForkRequest): Promise<RepositorySessionHeader> {
		this.#assertOpen();
		return this.#enqueueWrite(request, async transaction => {
			const current = await transaction.getHeader(request.branchId);
			if (!current) throw new Error(`Unknown branch ${request.branchId}`);
			if (!(await transaction.isEventReachable(request.branchId, request.atEventHash))) {
				throw new Error("Fork point is not in branch ancestry");
			}
			const targetBranchId = computeBranchIdentity({
				originId: current.originId,
				replicaId: this.replicaId,
				branchKey: `fork:${current.branchId}:${request.atEventHash ?? "root"}:${request.forkKey}`,
			}).id;
			const header = await transaction.fork({ request, targetBranchId });
			assertCommittedHeader(header, targetBranchId, current.originId);
			return header;
		});
	}

	async updateTitle(request: UpdateSessionTitleRequest): Promise<RepositorySessionHeader> {
		return this.#enqueueWrite(request, transaction => transaction.updateTitle(request));
	}

	async drop(request: DropSessionRequest): Promise<boolean> {
		if (request.explicit !== true) throw new TypeError("Drop requires explicit intent");
		return this.#enqueueWrite(request, transaction => transaction.drop(request));
	}

	async relocate(request: RelocateSessionRequest): Promise<SessionLocator> {
		if (request.logicalLocation.trim().length === 0) throw new TypeError("Logical location must not be empty");
		return this.#enqueueWrite(request, transaction => transaction.relocate(request));
	}

	async saveDraft(request: SaveDraftRequest): Promise<SessionDraft> {
		return this.#enqueueWrite(request, transaction => transaction.saveDraft(request));
	}

	async consumeDraft(request: ConsumeDraftRequest): Promise<SessionDraft | undefined> {
		return this.#enqueueWrite(request, transaction => transaction.consumeDraft(request));
	}

	async registerRelatedResource(request: RegisterRelatedResourceRequest): Promise<void> {
		await this.#enqueueWrite(request, transaction => transaction.registerRelatedResource(request));
	}

	async resolveRelatedResource(locator: RelatedResourceLocator): Promise<SessionLocator | undefined> {
		this.#assertOpen();
		return this.#adapter.resolveRelatedResource(locator);
	}

	async listRelatedResources(query: ListRelatedResourcesQuery): Promise<KeysetPage<RelatedResourceBinding>> {
		this.#assertOpen();
		const limit = this.#pageSize(query.limit);
		return this.#page(
			await this.#adapter.listRelatedResources({
				after: decodeKeyset(query.cursor),
				limit: limit + 1,
				owner: query.owner,
				kind: query.kind,
			}),
			limit,
		);
	}

	async setTerminalSessionPointer(request: SetTerminalSessionPointerRequest): Promise<void> {
		await this.#enqueueWrite(request, transaction => transaction.setTerminalSessionPointer(request));
	}

	async getTerminalSessionPointer(terminalId: string): Promise<TerminalSessionPointer | undefined> {
		this.#assertOpen();
		if (terminalId.length === 0) throw new TypeError("terminalId must not be empty");
		return this.#adapter.getTerminalSessionPointer(terminalId);
	}

	async setPinned(request: SetSessionPinnedRequest): Promise<void> {
		await this.#enqueueWrite(request, transaction => transaction.setPinned(request));
	}

	async listPinned(): Promise<readonly BranchId[]> {
		this.#assertOpen();
		const branchIds = await this.#adapter.listPinned(this.#maxPinnedResults + 1);
		if (branchIds.length > this.#maxPinnedResults) {
			throw new Error(`adapter returned more than the ${this.#maxPinnedResults}-pin bound`);
		}
		return branchIds;
	}

	async putCheckpoint(request: WriteCheckpointRequest): Promise<void> {
		await this.#enqueueWrite(request, transaction => transaction.putCheckpoint(request));
	}

	async *readContextTail(request: ReadContextTailRequest): AsyncIterable<RepositoryEvent> {
		this.#assertOpen();
		assertPositiveInteger(request.maxEntries, "maxEntries");
		if (request.checkpoint && request.checkpoint.branchId !== request.branchId) {
			throw new TypeError("Checkpoint belongs to another branch");
		}
		let count = 0;
		for await (const event of this.#adapter.readContextTail({
			branchId: request.branchId,
			afterEventHash: request.checkpoint?.headEventHash ?? undefined,
			limit: request.maxEntries,
		})) {
			count++;
			if (count > request.maxEntries) throw new Error(`adapter exceeded the ${request.maxEntries}-event context bound`);
			yield event;
		}
	}

	async writePayload(request: WritePayloadRequest): Promise<PayloadDescriptor> {
		this.#assertOpen();
		const descriptor = await this.#adapter.writePayload(request);
		if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0) {
			throw new Error("adapter returned an invalid payload length");
		}
		if (descriptor.payloadHash.length === 0) throw new Error("adapter returned an empty payload hash");
		return descriptor;
	}

	async *readPayload(request: ReadPayloadRequest): AsyncIterable<Uint8Array> {
		this.#assertOpen();
		const chunkBytes = request.chunkBytes ?? this.#payloadChunkBytes;
		assertPositiveInteger(chunkBytes, "chunkBytes");
		if (chunkBytes > this.#maxPayloadChunkBytes) {
			throw new RangeError(`chunkBytes exceeds the ${this.#maxPayloadChunkBytes}-byte bound`);
		}
		for await (const chunk of this.#adapter.readPayload({ payloadHash: request.payloadHash, chunkBytes })) {
			if (chunk.byteLength > chunkBytes) {
				throw new Error(`adapter emitted a ${chunk.byteLength}-byte payload chunk above the ${chunkBytes}-byte bound`);
			}
			yield chunk;
		}
	}

	async flush(request: FlushRequest): Promise<void> {
		this.#assertOpen();
		await this.#writers.flush();
		const receipt = await this.#adapter.flush(request.expectedModeGeneration);
		if (receipt.modeGeneration !== request.expectedModeGeneration || receipt.durable !== true) {
			throw new Error("Turso flush did not cross a matching durable mode-generation boundary");
		}
		if (receipt.committedSequence.length === 0) throw new Error("Turso flush omitted its durable commit sequence");
	}

	async health(): Promise<TursoRepositoryHealth> {
		this.#assertOpen();
		const health = await this.#adapter.health();
		const queue = this.#writers.stats;
		return {
			mode: "db",
			status: queue.failedTasks > 0 && health.status === "ok" ? "degraded" : health.status,
			replicaId: this.replicaId,
			modeGeneration: health.modeGeneration,
			writable: health.writable && !this.#closed,
			details:
				queue.lastError === undefined
					? health.details
					: [...(health.details ?? []), `Writer queue failure: ${String(queue.lastError)}`],
			queue,
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#writers.close();
		await this.#adapter.close();
	}

	#pageSize(requested: number | undefined): number {
		return normalizePageSize(requested, { defaultSize: this.#defaultPageSize, maxSize: this.#maxPageSize });
	}

	#page<T>(rows: readonly TursoKeysetRow<T>[], limit: number): KeysetPage<T> {
		const page = keysetPage(rows, limit, row => row.position);
		return {
			items: page.items.map(row => row.value),
			nextCursor: page.nextCursor as KeysetCursor | undefined,
		};
	}

	async #enqueueWrite<T>(
		request: { expectedModeGeneration: ModeGeneration },
		operation: (transaction: TursoRuntimeTransaction) => Promise<T>,
	): Promise<T> {
		this.#assertOpen();
		if (request.expectedModeGeneration.length === 0) throw new TypeError("Mode generation must not be empty");
		return this.#writers.enqueue(estimateMutationBytes(request), async () =>
			this.#adapter.transaction(async transaction => {
				await transaction.assertModeGeneration(request.expectedModeGeneration);
				return operation(transaction);
			}),
		);
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Turso session repository is closed");
	}
}

/** Construction itself never imports or opens the native database package. */
export function createTursoSessionRepository(options: TursoSessionRepositoryOptions): SessionRepository {
	return new TursoSessionRepository(options);
}

function appendFingerprint(request: AppendWithExpectedHeadRequest): string {
	const bytes = canonicalSerialize({
		expectedHeadHash: request.expectedHeadHash,
		entries: request.entries,
		metadata: request.metadata,
	});
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function estimateMutationBytes(value: unknown): number {
	try {
		return Math.max(1, encoder.encode(JSON.stringify(value)).byteLength);
	} catch {
		return 1;
	}
}

function assertCommittedHeader(header: RepositorySessionHeader, branchId: BranchId, originId: OriginId): void {
	if (header.branchId !== branchId) throw new Error("adapter committed an unexpected branch");
	if (header.originId !== originId) throw new Error("adapter changed the session origin");
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}
