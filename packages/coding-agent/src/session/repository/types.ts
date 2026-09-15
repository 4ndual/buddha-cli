import type { SessionEntry, SessionHeader, SessionTitleSource } from "../session-entries";

declare const repositoryIdBrand: unique symbol;

type BrandedId<Name extends string> = string & { readonly [repositoryIdBrand]: Name };

/** Opaque logical identifiers. They are content-addressed unless noted otherwise. */
export type OriginId = BrandedId<"OriginId">;
export type SourceAlias = BrandedId<"SourceAlias">;
export type EventHash = BrandedId<"EventHash">;
export type VersionId = BrandedId<"VersionId">;
export type BranchId = BrandedId<"BranchId">;
export type ReplicaId = BrandedId<"ReplicaId">;
export type PayloadHash = BrandedId<"PayloadHash">;
export type CheckpointId = BrandedId<"CheckpointId">;
export type ModeGeneration = BrandedId<"ModeGeneration">;

export type RepositoryMode = "jsonl" | "db";

/** A keyset cursor is backend-owned and must only be reused with the query that produced it. */
export type KeysetCursor = BrandedId<"KeysetCursor">;

export interface KeysetPage<T> {
	items: readonly T[];
	nextCursor?: KeysetCursor;
}

export interface SourceIdentity {
	/** Source harness, for example `omp`, `claude`, or `codex`. */
	sourceNamespace: string;
	/** Stable installation/profile namespace. Native ids are only unique inside this namespace. */
	installationNamespace: string;
	nativeId: string;
}

export interface SessionSemanticMetadata {
	title?: string;
	titleSource?: SessionTitleSource;
	createdAt: string;
	cwd?: string;
	additionalDirectories?: readonly string[];
	providerPromptCacheKey?: string;
	/** Namespaced semantic metadata retained by import adapters. */
	extensions?: Readonly<Record<string, unknown>>;
}

export interface RepositorySessionHeader {
	originId: OriginId;
	branchId: BranchId;
	versionId: VersionId;
	sourceAlias: SourceAlias;
	replicaId: ReplicaId;
	headEventHash: EventHash | null;
	forkPointHash: EventHash | null;
	parentVersionId: VersionId | null;
	generation: number;
	metadata: SessionSemanticMetadata;
	modifiedAt: string;
}

export interface RepositoryEvent {
	eventHash: EventHash;
	originId: OriginId;
	parentEventHash: EventHash | null;
	nativeEntryId: string;
	generation: number;
	entry: SessionEntry;
}

export interface RepositoryTreeNode extends RepositoryEvent {
	childEventHashes: readonly EventHash[];
}
/** Logical locator used by runtime callers; never a JSONL path. */
export interface SessionLocator {
	branchId: BranchId;
	versionId?: VersionId;
}

export interface ReadEventsQuery extends SessionLocator {
	limit?: number;
	cursor?: KeysetCursor;
}


export interface ListSessionsQuery {
	limit?: number;
	cursor?: KeysetCursor;
	originId?: OriginId;
	sourceAlias?: SourceAlias;
}

export interface SearchSessionsQuery {
	text: string;
	limit?: number;
	cursor?: KeysetCursor;
	originId?: OriginId;
}

export interface SessionSearchHit {
	header: RepositorySessionHeader;
	eventHash?: EventHash;
	snippet: string;
}

export interface ReadTreeQuery {
	branchId: BranchId;
	limit?: number;
	cursor?: KeysetCursor;
}

export interface GetHeaderRequest {
	branchId: BranchId;
}

export interface FencedWriteRequest {
	/** Persisted mode-generation token captured when the caller opened this repository. */
	expectedModeGeneration: ModeGeneration;
}

export interface AppendWithExpectedHeadRequest extends FencedWriteRequest {
	branchId: BranchId;
	/** Null is the expected head of an empty branch. */
	expectedHeadHash: EventHash | null;
	entries: readonly SessionEntry[];
	/** Replaces semantic metadata for the new immutable version when supplied. */
	metadata?: SessionSemanticMetadata;
}

export type AppendWithExpectedHeadResult =
	| {
			status: "appended" | "idempotent";
			header: RepositorySessionHeader;
	  }
	| {
			/** The requested append lost CAS and was preserved on a sibling branch. */
			status: "forked";
			header: RepositorySessionHeader;
			conflictedBranchId: BranchId;
	  };

export interface ForkRequest extends FencedWriteRequest {
	branchId: BranchId;
	atEventHash: EventHash | null;
	/** Stable caller key; retrying with the same key is idempotent. */
	forkKey: string;
	metadata?: SessionSemanticMetadata;
}
export interface UpdateSessionTitleRequest extends FencedWriteRequest {
	branchId: BranchId;
	expectedHeadHash: EventHash | null;
	title?: string;
	source?: SessionTitleSource;
	updatedAt: string;
}

export interface DropSessionRequest extends FencedWriteRequest {
	locator: SessionLocator;
	/** Required explicit intent; absence in another backend is never interpreted as this request. */
	explicit: true;
}

export interface RelocateSessionRequest extends FencedWriteRequest {
	locator: SessionLocator;
	/** Backend-neutral collection/profile locator, not a filesystem path. */
	logicalLocation: string;
}

export interface SessionDraft {
	branchId: BranchId;
	revision: string;
	payloadHash: PayloadHash;
	updatedAt: string;
}

export interface SaveDraftRequest extends FencedWriteRequest {
	draft: SessionDraft;
	expectedRevision: string | null;
}

export interface ConsumeDraftRequest extends FencedWriteRequest {
	branchId: BranchId;
	expectedRevision: string;
}

export type RelatedResourceKind = "artifact" | "child-session" | "advisor-session";

export interface RelatedResourceLocator {
	owner: SessionLocator;
	kind: RelatedResourceKind;
	key: string;
}

export interface RegisterRelatedResourceRequest extends FencedWriteRequest {
	locator: RelatedResourceLocator;
	target: SessionLocator;
}

export interface TerminalSessionPointer {
	terminalId: string;
	session: SessionLocator;
	updatedAt: string;
}

export interface SetTerminalSessionPointerRequest extends FencedWriteRequest {
	pointer: TerminalSessionPointer;
}

export interface SetSessionPinnedRequest extends FencedWriteRequest {
	branchId: BranchId;
	pinned: boolean;
}


export interface ContextCheckpoint {
	checkpointId: CheckpointId;
	branchId: BranchId;
	headEventHash: EventHash | null;
	contextBuilderVersion: string;
	contextHash: string;
	payloadHash: PayloadHash;
	createdAt: string;
}
export interface WriteCheckpointRequest extends FencedWriteRequest {
	checkpoint: ContextCheckpoint;
}


export interface ReadContextTailRequest {
	branchId: BranchId;
	/** When supplied, events after this exact checkpoint head are emitted. */
	checkpoint?: ContextCheckpoint;
	/** Required upper bound. Prevents accidentally materializing an unbounded branch. */
	maxEntries: number;
}

export interface WritePayloadRequest {
	bytes: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
	mediaType?: string;
}

export interface PayloadDescriptor {
	payloadHash: PayloadHash;
	byteLength: number;
	mediaType?: string;
}

export interface ReadPayloadRequest {
	payloadHash: PayloadHash;
	chunkBytes?: number;
}

/** Portable logical record. Physical export paths and transfer timestamps are deliberately absent. */
export interface SessionArchiveItem {
	source: SourceIdentity;
	sourceAlias: SourceAlias;
	originId: OriginId;
	branchId: BranchId;
	versionId: VersionId;
	parentVersionId: VersionId | null;
	forkPointHash: EventHash | null;
	header: SessionHeader;
	entries: readonly SessionEntry[];
	metadata: SessionSemanticMetadata;
}

/** Explicit logical selection for export; callers never pass an internal JSONL path. */
export interface SessionExportLocator extends SessionLocator {
	originId: OriginId;
}

export type SessionImportItem = SessionArchiveItem;
export type SessionExportItem = SessionArchiveItem;

export interface ImportArchiveOptions extends FencedWriteRequest {
	/** Durable namespace of the producer, used to stabilize rediscovered branch mappings. */
	sourceReplicaId?: ReplicaId;
}

export interface ExportArchiveQuery {
	originId?: OriginId;
	branchId?: BranchId;
	cursor?: KeysetCursor;
	limit?: number;
}

export interface SyncOptions extends ImportArchiveOptions {
	originId?: OriginId;
}

export interface TransferReport {
	imported: number;
	extended: number;
	forked: number;
	duplicates: number;
	quarantined: number;
	/** Always zero unless explicit tombstones are added to a future version of this contract. */
	deleted: 0;
}

export interface RepositoryHealth {
	mode: RepositoryMode;
	status: "ok" | "degraded" | "unavailable";
	replicaId: ReplicaId;
	modeGeneration: ModeGeneration;
	writable: boolean;
	details?: readonly string[];
}

export interface RepositoryCapabilities {
	keysetPagination: true;
	streamingPayloads: true;
	expectedHeadCas: true;
	siblingForkOnConflict: true;
	modeGenerationFencing: true;
}

export interface FlushRequest extends FencedWriteRequest {}

/**
 * Runtime storage boundary shared by JSONL and database backends.
 *
 * Pagination is keyset-based, payloads are streamed, appends are compare-and-swap,
 * and every state-publishing operation is fenced by the persisted mode generation.
 * Archive filesystem access is deliberately isolated in {@link SessionTransferService}.
 */
export interface SessionRepository {
	readonly mode: RepositoryMode;
	readonly replicaId: ReplicaId;

	capabilities(): RepositoryCapabilities;
	listSessions(query?: ListSessionsQuery): Promise<KeysetPage<RepositorySessionHeader>>;
	search(query: SearchSessionsQuery): Promise<KeysetPage<SessionSearchHit>>;
	readTree(query: ReadTreeQuery): Promise<KeysetPage<RepositoryTreeNode>>;
	getHeader(request: GetHeaderRequest): Promise<RepositorySessionHeader | undefined>;
	readEvents(query: ReadEventsQuery): Promise<KeysetPage<RepositoryEvent>>;


	appendWithExpectedHead(request: AppendWithExpectedHeadRequest): Promise<AppendWithExpectedHeadResult>;
	fork(request: ForkRequest): Promise<RepositorySessionHeader>;
	updateTitle(request: UpdateSessionTitleRequest): Promise<RepositorySessionHeader>;
	drop(request: DropSessionRequest): Promise<boolean>;
	relocate(request: RelocateSessionRequest): Promise<SessionLocator>;

	saveDraft(request: SaveDraftRequest): Promise<SessionDraft>;
	consumeDraft(request: ConsumeDraftRequest): Promise<SessionDraft | undefined>;

	registerRelatedResource(request: RegisterRelatedResourceRequest): Promise<void>;
	resolveRelatedResource(locator: RelatedResourceLocator): Promise<SessionLocator | undefined>;
	setTerminalSessionPointer(request: SetTerminalSessionPointerRequest): Promise<void>;
	getTerminalSessionPointer(terminalId: string): Promise<TerminalSessionPointer | undefined>;
	setPinned(request: SetSessionPinnedRequest): Promise<void>;
	listPinned(): Promise<readonly BranchId[]>;


	putCheckpoint(request: WriteCheckpointRequest): Promise<void>;
	readContextTail(request: ReadContextTailRequest): AsyncIterable<RepositoryEvent>;

	writePayload(request: WritePayloadRequest): Promise<PayloadDescriptor>;
	readPayload(request: ReadPayloadRequest): AsyncIterable<Uint8Array>;

	flush(request: FlushRequest): Promise<void>;
	health(): Promise<RepositoryHealth>;
	close(): Promise<void>;
}

/**
 * Explicit archive/JSONL transfer boundary. Runtime DB operations never receive
 * this service, so they cannot accidentally scan session files.
 */
export interface SessionTransferService {
	importArchive(
		items: AsyncIterable<SessionImportItem> | Iterable<SessionImportItem>,
		options: ImportArchiveOptions,
	): Promise<TransferReport>;
	exportArchive(query?: ExportArchiveQuery): AsyncIterable<SessionExportItem>;
	syncFrom(source: SessionTransferService, options: SyncOptions): Promise<TransferReport>;
}
