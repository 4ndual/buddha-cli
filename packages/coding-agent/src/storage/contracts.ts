import type { SessionEntry, SessionHeader } from "../session/session-entries";

export type StorageMode = "jsonl" | "db";
export type StorageCapabilityState = "available" | "unavailable" | "disabled";
export type StorageHealthStatus = "healthy" | "degraded" | "unavailable";
export type StorageDurability = "process" | "power-loss";
export type StorageJobState = "pending" | "running" | "cancel-requested" | "completed" | "failed" | "quarantined";
export type StorageJobControl = "cancel-after-current-batch" | "resume";
export type StorageTransferDirection = "jsonl-to-db" | "db-to-jsonl" | "synchronize";
export type SessionDisposition = "resumable" | "resumable-with-mapping" | "archive-only" | "quarantined";

declare const originIdBrand: unique symbol;
declare const sourceAliasBrand: unique symbol;
declare const eventHashBrand: unique symbol;
declare const versionIdBrand: unique symbol;
declare const branchIdBrand: unique symbol;
declare const replicaIdBrand: unique symbol;
declare const payloadIdBrand: unique symbol;
declare const metadataRevisionIdBrand: unique symbol;
declare const contextHashBrand: unique symbol;
declare const repositoryCursorBrand: unique symbol;

export type OriginId = string & { readonly [originIdBrand]: "OriginId" };
export type SourceAlias = string & { readonly [sourceAliasBrand]: "SourceAlias" };
export type EventHash = string & { readonly [eventHashBrand]: "EventHash" };
export type VersionId = string & { readonly [versionIdBrand]: "VersionId" };
export type BranchId = string & { readonly [branchIdBrand]: "BranchId" };
export type ReplicaId = string & { readonly [replicaIdBrand]: "ReplicaId" };
export type PayloadId = string & { readonly [payloadIdBrand]: "PayloadId" };
export type MetadataRevisionId = string & { readonly [metadataRevisionIdBrand]: "MetadataRevisionId" };
export type ContextHash = string & { readonly [contextHashBrand]: "ContextHash" };
export type RepositoryCursor = string & { readonly [repositoryCursorBrand]: "RepositoryCursor" };

export interface StorageCapability {
	state: StorageCapabilityState;
	reason?: string;
	verifiedAt?: string;
	details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RepositoryCapabilities {
	mode: StorageMode;
	persistence: StorageCapability;
	search: StorageCapability;
	payloadStreaming: StorageCapability;
	archiveImport: StorageCapability;
	archiveExport: StorageCapability;
	backup: StorageCapability;
	recovery: StorageCapability;
	nativeBridge: StorageCapability;
	fts5: StorageCapability;
	compression: StorageCapability;
	encryption: StorageCapability;
}

export interface SearchHealth {
	status: StorageHealthStatus;
	indexedThroughGeneration: number;
	committedGeneration: number;
	pendingDocuments: number;
	lastError?: string;
}

export interface RepositoryHealth {
	mode: StorageMode;
	status: StorageHealthStatus;
	writable: boolean;
	schemaVersion?: number;
	minimumReaderVersion?: number;
	replicaId: ReplicaId;
	capabilities: RepositoryCapabilities;
	search: SearchHealth;
	openReaders: number;
	queuedWriterBytes: number;
	lastDurableCommitAt?: string;
	lastVerifiedTransferAt?: string;
	issues: readonly string[];
}

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
export const MAX_CURSOR_BYTES = 4_096;

export interface PageRequest {
	cursor?: RepositoryCursor;
	limit?: number;
}

export interface BoundedPageRequest {
	cursor?: RepositoryCursor;
	limit: number;
}

export interface Page<T> {
	items: readonly T[];
	nextCursor?: RepositoryCursor;
}

export function boundPageRequest(request: PageRequest = {}): BoundedPageRequest {
	const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
		throw new RangeError(`Page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
	}
	if (request.cursor !== undefined && new TextEncoder().encode(request.cursor).byteLength > MAX_CURSOR_BYTES) {
		throw new RangeError(`Page cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
	}
	return request.cursor === undefined ? { limit } : { cursor: request.cursor, limit };
}

const CURSOR_PREFIX = "omp-storage-cursor-v1.";

export function encodePageCursor(fields: Readonly<Record<string, string | number | boolean | null>>): RepositoryCursor {
	for (const value of Object.values(fields)) {
		if (
			value !== null &&
			typeof value !== "string" &&
			typeof value !== "boolean" &&
			(typeof value !== "number" || !Number.isSafeInteger(value))
		) {
			throw new TypeError("Page cursor fields must be strings, safe integers, booleans, or null");
		}
	}
	const ordered = Object.fromEntries(
		Object.entries(fields).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
	const payload = Buffer.from(JSON.stringify(ordered), "utf8").toString("base64url");
	const cursor = `${CURSOR_PREFIX}${payload}`;
	if (new TextEncoder().encode(cursor).byteLength > MAX_CURSOR_BYTES) {
		throw new RangeError(`Page cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
	}
	return cursor as RepositoryCursor;
}

export function decodePageCursor(cursor: RepositoryCursor): Readonly<Record<string, string | number | boolean | null>> {
	if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error("Unsupported page cursor version");
	if (new TextEncoder().encode(cursor).byteLength > MAX_CURSOR_BYTES) {
		throw new RangeError(`Page cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
	} catch {
		throw new Error("Malformed page cursor");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Malformed page cursor");
	for (const value of Object.values(parsed)) {
		if (
			value !== null &&
			typeof value !== "string" &&
			typeof value !== "boolean" &&
			(typeof value !== "number" || !Number.isSafeInteger(value))
		) {
			throw new Error("Malformed page cursor");
		}
	}
	return parsed as Readonly<Record<string, string | number | boolean | null>>;
}

export interface SessionIdentity {
	originId: OriginId;
	branchId: BranchId;
	versionId: VersionId;
	replicaId: ReplicaId;
	sourceAliases: readonly SourceAlias[];
	forkPointHash: EventHash | null;
	parentVersionId: VersionId | null;
	headHash: EventHash | null;
}

export interface RepositorySessionHeader {
	identity: SessionIdentity;
	header: SessionHeader;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	entryCount: number;
	payloadBytes: number;
	disposition: SessionDisposition;
}

export type SessionSort = "modified-desc" | "created-desc" | "title-asc";

export interface SessionListQuery extends PageRequest {
	originId?: OriginId;
	branchId?: BranchId;
	cwd?: string;
	disposition?: SessionDisposition;
	modifiedAfter?: string;
	modifiedBefore?: string;
	sort?: SessionSort;
}

export interface SessionSearchQuery extends PageRequest {
	text: string;
	originId?: OriginId;
	branchId?: BranchId;
	roles?: readonly string[];
	from?: string;
	to?: string;
	requireCompleteIndex?: boolean;
	maxSnippetBytes?: number;
}

export interface SessionSearchHit {
	eventHash: EventHash;
	originId: OriginId;
	reachableBranchIds: readonly BranchId[];
	entryId: string;
	role?: string;
	timestamp: string;
	snippet: string;
	rank: number;
}

export interface SessionTreeQuery extends PageRequest {
	branchId: BranchId;
	fromHash?: EventHash | null;
	direction?: "ancestors" | "descendants";
}

export interface SessionTreeEvent {
	eventHash: EventHash;
	parentHash: EventHash | null;
	originId: OriginId;
	nativeEntryId: string;
	kind: SessionEntry["type"];
	timestamp: string;
	payloadId: PayloadId;
	canonicalizerVersion: number;
	entry?: SessionEntry;
}

export interface AppendSessionRequest {
	branchId: BranchId;
	expectedHeadHash: EventHash | null;
	entry: SessionEntry;
	replicaId: ReplicaId;
	operationId: string;
	/** Stable source identity when the append came from an imported working copy. */
	sourceAlias?: SourceAlias;
}

export interface AppendCommit {
	outcome: "committed";
	branchId: BranchId;
	versionId: VersionId;
	eventHash: EventHash;
	generation: number;
	durability: StorageDurability;
}

export interface AppendIdempotent {
	outcome: "idempotent";
	branchId: BranchId;
	versionId: VersionId;
	eventHash: EventHash;
	generation: number;
	durability: StorageDurability;
}

export interface AppendSiblingFork {
	outcome: "sibling-fork";
	branchId: BranchId;
	winnerBranchId: BranchId;
	versionId: VersionId;
	eventHash: EventHash;
	forkPointHash: EventHash | null;
	generation: number;
	durability: StorageDurability;
}

export type AppendSessionResult = AppendCommit | AppendIdempotent | AppendSiblingFork;

export interface ForkSessionRequest {
	originId: OriginId;
	fromBranchId: BranchId;
	forkPointHash: EventHash | null;
	parentVersionId: VersionId;
	replicaId: ReplicaId;
	operationId: string;
	/** Caller-stable identity. Repeating the request returns the same branch. */
	branchKey: string;
}

export interface ForkSessionResult {
	branchId: BranchId;
	versionId: VersionId;
	headHash: EventHash | null;
	forkPointHash: EventHash | null;
	created: boolean;
}

export interface ContextCheckpoint {
	branchId: BranchId;
	headHash: EventHash | null;
	contextBuilderVersion: string;
	contextHash: ContextHash;
	payloadId: PayloadId;
	entryCount: number;
	createdAt: string;
}

export interface WriteContextCheckpointRequest {
	checkpoint: ContextCheckpoint;
	expectedHeadHash: EventHash | null;
	operationId: string;
}

export interface ContextTailRequest {
	branchId: BranchId;
	afterHash?: EventHash | null;
	throughHash?: EventHash | null;
	maxEntries: number;
	maxPayloadBytes: number;
}

export const MAX_CONTEXT_TAIL_ENTRIES = 5_000;
export const MAX_CONTEXT_TAIL_PAYLOAD_BYTES = 64 * 1024 * 1024;

export function validateContextTailRequest(request: ContextTailRequest): ContextTailRequest {
	if (!Number.isSafeInteger(request.maxEntries) || request.maxEntries < 1 || request.maxEntries > MAX_CONTEXT_TAIL_ENTRIES) {
		throw new RangeError(`Context tail maxEntries must be between 1 and ${MAX_CONTEXT_TAIL_ENTRIES}`);
	}
	if (
		!Number.isSafeInteger(request.maxPayloadBytes) ||
		request.maxPayloadBytes < 1 ||
		request.maxPayloadBytes > MAX_CONTEXT_TAIL_PAYLOAD_BYTES
	) {
		throw new RangeError(`Context tail maxPayloadBytes must be between 1 and ${MAX_CONTEXT_TAIL_PAYLOAD_BYTES}`);
	}
	return request;
}

export interface ContextTail {
	checkpoint?: ContextCheckpoint;
	entries: readonly SessionTreeEvent[];
	complete: boolean;
	nextHash?: EventHash;
}

export interface PayloadStreamRequest {
	payloadId: PayloadId;
	offset?: number;
	length?: number;
	chunkBytes?: number;
}

export const DEFAULT_PAYLOAD_CHUNK_BYTES = 64 * 1024;
export const MAX_PAYLOAD_CHUNK_BYTES = 1024 * 1024;

export interface BoundedPayloadStreamRequest {
	payloadId: PayloadId;
	offset: number;
	length?: number;
	chunkBytes: number;
}

export function boundPayloadStreamRequest(request: PayloadStreamRequest): BoundedPayloadStreamRequest {
	const offset = request.offset ?? 0;
	const chunkBytes = request.chunkBytes ?? DEFAULT_PAYLOAD_CHUNK_BYTES;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Payload offset must be a non-negative safe integer");
	if (request.length !== undefined && (!Number.isSafeInteger(request.length) || request.length < 0)) {
		throw new RangeError("Payload length must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_PAYLOAD_CHUNK_BYTES) {
		throw new RangeError(`Payload chunkBytes must be between 1 and ${MAX_PAYLOAD_CHUNK_BYTES}`);
	}
	return request.length === undefined
		? { payloadId: request.payloadId, offset, chunkBytes }
		: { payloadId: request.payloadId, offset, length: request.length, chunkBytes };
}

export interface PayloadChunk {
	payloadId: PayloadId;
	offset: number;
	bytes: Uint8Array;
	final: boolean;
	contentHash: string;
	totalLength: number;
	codec: string;
}

export interface ArchiveStream {
	chunks: AsyncIterable<Uint8Array>;
	byteLength?: number;
	sha256?: string;
}

export interface ArchiveImportRequest {
	jobId: string;
	replicaId: ReplicaId;
	archive: ArchiveStream;
	sourceAlias?: SourceAlias;
	dryRun?: boolean;
	batchBytes?: number;
	signal?: AbortSignal;
}

export const DEFAULT_IMPORT_BATCH_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BYTES = 32 * 1024 * 1024;

export function boundImportBatchBytes(batchBytes = DEFAULT_IMPORT_BATCH_BYTES): number {
	if (!Number.isSafeInteger(batchBytes) || batchBytes < 1 || batchBytes > MAX_IMPORT_BATCH_BYTES) {
		throw new RangeError(`Import batchBytes must be between 1 and ${MAX_IMPORT_BATCH_BYTES}`);
	}
	return batchBytes;
}

export interface ArchiveExportRequest {
	jobId: string;
	scope:
		| { type: "branch"; branchId: BranchId }
		| { type: "origin"; originId: OriginId; allBranches: true }
		| { type: "archive" };
	cutoffVersionId?: VersionId;
	signal?: AbortSignal;
}

export interface ArchiveManifest {
	format: "omp-session-bundle";
	formatVersion: number;
	jobId: string;
	createdAt: string;
	cutoffVersions: readonly VersionId[];
	itemCount: number;
	payloadBytes: number;
	sha256: string;
}

export interface ArchiveExport {
	manifest: ArchiveManifest;
	chunks: AsyncIterable<Uint8Array>;
}

export interface StorageTransferCounts {
	newOrigins: number;
	newVersions: number;
	extensions: number;
	siblingForks: number;
	duplicates: number;
	quarantined: number;
}

export interface StorageTransferPreview {
	jobId: string;
	direction: StorageTransferDirection;
	dryRun: true;
	counts: StorageTransferCounts;
	inputBytes: number;
	requiredBytes: number;
	warnings: readonly string[];
}

export interface StorageTransferReport {
	jobId: string;
	direction: StorageTransferDirection;
	state: StorageJobState;
	counts: StorageTransferCounts;
	committedItems: number;
	committedBytes: number;
	cursor?: string;
	manifestHash?: string;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	error?: string;
}

export interface IntegrityIssue {
	code: string;
	severity: "error" | "warning";
	subject: string;
	details?: string;
}

export interface IntegrityReport {
	verifiedAt: string;
	cutoffGeneration: number;
	origins: number;
	branches: number;
	versions: number;
	events: number;
	payloads: number;
	issues: readonly IntegrityIssue[];
}

export interface BackupRequest {
	jobId: string;
	destination: string;
	signal?: AbortSignal;
}

export interface BackupReceipt {
	jobId: string;
	createdAt: string;
	cutoffGeneration: number;
	byteLength: number;
	sha256: string;
	manifestPath: string;
}

export interface FlushRequest {
	durability?: StorageDurability;
	signal?: AbortSignal;
}

/**
 * Storage-domain boundary shared by JSONL and database modes.
 *
 * Implementations must not silently fall back to another mode, propagate deletion
 * from absence, acknowledge queued-but-uncommitted writes, or materialize an
 * entire archive merely to serve one page/payload stream.
 */
export interface SessionRepository {
	readonly mode: StorageMode;
	readonly replicaId: ReplicaId;
	capabilities(): Promise<RepositoryCapabilities>;
	listSessions(query?: SessionListQuery): Promise<Page<RepositorySessionHeader>>;
	searchSessions(query: SessionSearchQuery): Promise<Page<SessionSearchHit>>;
	listTree(query: SessionTreeQuery): Promise<Page<SessionTreeEvent>>;
	getHeader(branchId: BranchId): Promise<RepositorySessionHeader | undefined>;
	append(request: AppendSessionRequest): Promise<AppendSessionResult>;
	fork(request: ForkSessionRequest): Promise<ForkSessionResult>;
	writeContextCheckpoint(request: WriteContextCheckpointRequest): Promise<void>;
	readContextTail(request: ContextTailRequest): Promise<ContextTail>;
	streamPayload(request: PayloadStreamRequest): AsyncIterable<PayloadChunk>;
	previewImport(request: ArchiveImportRequest): Promise<StorageTransferPreview>;
	importArchive(request: ArchiveImportRequest): Promise<StorageTransferReport>;
	exportArchive(request: ArchiveExportRequest): Promise<ArchiveExport>;
	getTransferJob(jobId: string): Promise<StorageTransferReport | undefined>;
	controlTransferJob(jobId: string, control: StorageJobControl): Promise<StorageTransferReport>;
	verify(signal?: AbortSignal): Promise<IntegrityReport>;
	backup(request: BackupRequest): Promise<BackupReceipt>;
	flush(request?: FlushRequest): Promise<void>;
	health(): Promise<RepositoryHealth>;
	close(): Promise<void>;
}
