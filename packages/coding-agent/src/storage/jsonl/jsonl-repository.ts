import type {
	AppendSessionBatchRequest,
	AppendSessionRequest,
	AppendSessionResult,
	ArchiveExport,
	ArchiveExportRequest,
	ArchiveImportRequest,
	BackupReceipt,
	BackupRequest,
	CreateSessionRequest,
	CreateSessionResult,
	BranchId,
	ContextTail,
	ContextTailRequest,
	EventHash,
	FlushRequest,
	ForkSessionRequest,
	ForkSessionResult,
	IntegrityReport,
	Page,
	PayloadChunk,
	PayloadStreamRequest,
	RepositoryCapabilities,
	RepositoryCursor,
	ReplicaId,
	RepositoryHealth,
	RepositorySessionHeader,
	SessionListQuery,
	SessionRepository,
	SessionSearchHit,
	SessionSearchQuery,
	SessionTreeEvent,
	SessionTreeQuery,
	StorageJobControl,
	StorageTransferPreview,
	StorageTransferReport,
	WriteContextCheckpointRequest,
} from "../contracts";
import { boundPageRequest, decodePageCursor, encodePageCursor } from "../contracts";
import {
	branchId,
	CANONICALIZER_VERSION,
	eventIdentityRecord,
	metadataRevisionId,
	originId,
	payloadId,
	sessionEntrySemanticPayload,
	sourceAlias,
	versionId,
	type CanonicalValue,
} from "../identity";
import { loadSessionFile } from "../../session/session-loader";
import { listSessions, type SessionInfo } from "../../session/session-listing";
import { FileSessionStorage, type SessionStorage } from "../../session/session-storage";
import type { SessionEntry, SessionHeader } from "../../session/session-entries";

export type JsonlRepositoryOperations = Pick<
	SessionRepository,
	| "createSession"
	| "capabilities"
	| "appendBatch"
	| "append"
	| "fork"
	| "writeContextCheckpoint"
	| "readContextTail"
	| "streamPayload"
	| "previewImport"
	| "importArchive"
	| "exportArchive"
	| "getTransferJob"
	| "controlTransferJob"
	| "verify"
	| "backup"
	| "flush"
	| "health"
	| "close"
>;

export interface JsonlSessionRepositoryOptions {
	readonly sessionDir: string;
	readonly replicaId: ReplicaId;
	readonly installNamespace: string;
	readonly storage?: SessionStorage;
	/** Existing JSONL mutation/transfer services; the adapter never reimplements them. */
	readonly operations: JsonlRepositoryOperations;
}

interface JsonlHeaderIndex {
	readonly path: string;
	readonly header: RepositorySessionHeader;
}

interface IndexedJsonlSession extends JsonlHeaderIndex {
	readonly events: readonly SessionTreeEvent[];
}

function cursorOffset(cursor: RepositoryCursor | undefined): number {
	if (!cursor) return 0;
	const value = decodePageCursor(cursor).offset;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Malformed JSONL page cursor");
	return value;
}

function offsetPage<T>(items: readonly T[], cursor: RepositoryCursor | undefined, limit: number): Page<T> {
	const offset = cursorOffset(cursor);
	const pageItems = items.slice(offset, offset + limit);
	const nextOffset = offset + pageItems.length;
	return {
		items: pageItems,
		...(nextOffset < items.length ? { nextCursor: encodePageCursor({ offset: nextOffset }) } : {}),
	};
}

function eventText(entry: SessionEntry): string {
	if (entry.type !== "message" || !("content" in entry.message)) return JSON.stringify(entry);
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(entry.message);
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join(" ");
}

function buildEvents(origin: RepositorySessionHeader["identity"]["originId"], entries: readonly SessionEntry[]): SessionTreeEvent[] {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const hashes = new Map<string, EventHash>();
	const active = new Set<string>();
	const visit = (entry: SessionEntry): EventHash => {
		const existing = hashes.get(entry.id);
		if (existing) return existing;
		if (active.has(entry.id)) throw new Error(`Cannot hash cyclic JSONL entry graph at ${entry.id}`);
		active.add(entry.id);
		const parentHash = entry.parentId && byId.has(entry.parentId) ? visit(byId.get(entry.parentId)!) : null;
		const semanticPayload = sessionEntrySemanticPayload(entry);
		const identity = eventIdentityRecord({
			originId: origin,
			nativeEntryId: entry.id,
			parentHash,
			kind: entry.type,
			timestamp: entry.timestamp,
			semanticPayload,
		});
		active.delete(entry.id);
		hashes.set(entry.id, identity.eventHash);
		return identity.eventHash;
	};
	for (const entry of entries) visit(entry);
	return entries.map(entry => {
		const semanticPayload = sessionEntrySemanticPayload(entry);
		return {
			eventHash: hashes.get(entry.id)!,
			parentHash: entry.parentId ? (hashes.get(entry.parentId) ?? null) : null,
			originId: origin,
			nativeEntryId: entry.id,
			kind: entry.type,
			timestamp: entry.timestamp,
			payloadId: payloadId(semanticPayload),
			canonicalizerVersion: CANONICALIZER_VERSION,
			entry,
		};
	});
}
/**
 * JSONL read adapter over the established session loader/listing behavior.
 * Specialized mutation and transfer behavior is supplied by the existing JSONL
 * services, so this module introduces no second writer or archive convention.
 */
export class JsonlSessionRepository implements SessionRepository {
	readonly mode = "jsonl" as const;
	readonly replicaId: ReplicaId;
	readonly #sessionDir: string;
	readonly #installNamespace: string;
	readonly #storage: SessionStorage;
	readonly #operations: JsonlRepositoryOperations;

	constructor(options: JsonlSessionRepositoryOptions) {
		this.replicaId = options.replicaId;
		this.#sessionDir = options.sessionDir;
		this.#installNamespace = options.installNamespace;
		this.#storage = options.storage ?? new FileSessionStorage();
		this.#operations = options.operations;
	}

	capabilities(): Promise<RepositoryCapabilities> {
		return this.#operations.capabilities();
	}

	async listSessions(query: SessionListQuery = {}): Promise<Page<RepositorySessionHeader>> {
		const bounded = boundPageRequest(query);
		let sessions = await this.#headers();
		if (query.originId) sessions = sessions.filter(session => session.header.identity.originId === query.originId);
		if (query.branchId) sessions = sessions.filter(session => session.header.identity.branchId === query.branchId);
		if (query.cwd) sessions = sessions.filter(session => session.header.header.cwd === query.cwd);
		if (query.disposition) sessions = sessions.filter(session => session.header.disposition === query.disposition);
		if (query.modifiedAfter) sessions = sessions.filter(session => session.header.modifiedAt > query.modifiedAfter!);
		if (query.modifiedBefore) sessions = sessions.filter(session => session.header.modifiedAt < query.modifiedBefore!);
		if (query.sort === "created-desc") sessions.sort((left, right) => right.header.createdAt.localeCompare(left.header.createdAt));
		else if (query.sort === "title-asc") {
			sessions.sort((left, right) => (left.header.header.title ?? "").localeCompare(right.header.header.title ?? ""));
		}
		return offsetPage(sessions.map(session => session.header), bounded.cursor, bounded.limit);
	}

	async searchSessions(query: SessionSearchQuery): Promise<Page<SessionSearchHit>> {
		const bounded = boundPageRequest(query);
		const offset = cursorOffset(bounded.cursor);
		const needle = query.text.toLocaleLowerCase();
		const maxSnippetBytes = Math.max(32, Math.min(query.maxSnippetBytes ?? 512, 4_096));
		const hits: SessionSearchHit[] = [];
		let skipped = 0;
		let hasMore = false;
		search: for (const info of await listSessions(this.#sessionDir, this.#storage)) {
			const ids = this.#ids(info.id);
			if (query.originId && ids.origin !== query.originId) continue;
			if (query.branchId && ids.branch !== query.branchId) continue;
			const session = await this.#loadSession(info);
			if (!session) continue;
			for (const event of session.events) {
				if (!event.entry) continue;
				const role = event.entry.type === "message" ? event.entry.message.role : undefined;
				if (query.roles && (!role || !query.roles.includes(role))) continue;
				if (query.from && event.timestamp < query.from) continue;
				if (query.to && event.timestamp > query.to) continue;
				const text = eventText(event.entry);
				const index = text.toLocaleLowerCase().indexOf(needle);
				if (index < 0) continue;
				if (skipped++ < offset) continue;
				if (hits.length === bounded.limit) {
					hasMore = true;
					break search;
				}
				const start = Math.max(0, index - Math.floor(maxSnippetBytes / 3));
				const snippet = new TextDecoder().decode(new TextEncoder().encode(text.slice(start)).subarray(0, maxSnippetBytes));
				hits.push({
					eventHash: event.eventHash,
					originId: event.originId,
					reachableBranchIds: [session.header.identity.branchId],
					entryId: event.nativeEntryId,
					...(role ? { role } : {}),
					timestamp: event.timestamp,
					snippet,
					rank: index,
				});
			}
		}
		return {
			items: hits,
			...(hasMore ? { nextCursor: encodePageCursor({ offset: offset + hits.length }) } : {}),
		};
	}

	async listTree(query: SessionTreeQuery): Promise<Page<SessionTreeEvent>> {
		const bounded = boundPageRequest(query);
		const session = await this.#findSession(query.branchId);
		if (!session) return { items: [] };
		let events = [...session.events];
		if (query.fromHash !== undefined) {
			const index = events.findIndex(event => event.eventHash === query.fromHash);
			events = index < 0 ? [] : events.slice(index + 1);
		}
		if (query.direction !== "descendants") events.reverse();
		return offsetPage(events, bounded.cursor, bounded.limit);
	}

	async getHeader(branch: BranchId): Promise<RepositorySessionHeader | undefined> {
		return (await this.#headers()).find(session => session.header.identity.branchId === branch)?.header;
	}

	createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
		return this.#operations.createSession(request);
	}

	append(request: AppendSessionRequest): Promise<AppendSessionResult> {
		return this.#operations.append(request);
	}

	appendBatch(request: AppendSessionBatchRequest): Promise<AppendSessionResult> {
		return this.#operations.appendBatch(request);
	}

	fork(request: ForkSessionRequest): Promise<ForkSessionResult> {
		return this.#operations.fork(request);
	}

	writeContextCheckpoint(request: WriteContextCheckpointRequest): Promise<void> {
		return this.#operations.writeContextCheckpoint(request);
	}

	readContextTail(request: ContextTailRequest): Promise<ContextTail> {
		return this.#operations.readContextTail(request);
	}

	streamPayload(request: PayloadStreamRequest): AsyncIterable<PayloadChunk> {
		return this.#operations.streamPayload(request);
	}

	previewImport(request: ArchiveImportRequest): Promise<StorageTransferPreview> {
		return this.#operations.previewImport(request);
	}

	importArchive(request: ArchiveImportRequest): Promise<StorageTransferReport> {
		return this.#operations.importArchive(request);
	}

	exportArchive(request: ArchiveExportRequest): Promise<ArchiveExport> {
		return this.#operations.exportArchive(request);
	}

	getTransferJob(jobId: string): Promise<StorageTransferReport | undefined> {
		return this.#operations.getTransferJob(jobId);
	}

	controlTransferJob(jobId: string, control: StorageJobControl): Promise<StorageTransferReport> {
		return this.#operations.controlTransferJob(jobId, control);
	}

	verify(signal?: AbortSignal): Promise<IntegrityReport> {
		return this.#operations.verify(signal);
	}

	backup(request: BackupRequest): Promise<BackupReceipt> {
		return this.#operations.backup(request);
	}

	flush(request?: FlushRequest): Promise<void> {
		return this.#operations.flush(request);
	}

	health(): Promise<RepositoryHealth> {
		return this.#operations.health();
	}

	close(): Promise<void> {
		return this.#operations.close();
	}

	#ids(nativeSessionId: string) {
		const aliasInput = { harness: "omp", installNamespace: this.#installNamespace, nativeSessionId };
		const origin = originId(aliasInput);
		return {
			alias: sourceAlias(aliasInput),
			origin,
			branch: branchId({ originId: origin, replicaId: this.replicaId, branchKey: nativeSessionId }),
		};
	}

	async #loadSession(info: SessionInfo): Promise<IndexedJsonlSession | undefined> {
		const loaded = await loadSessionFile(info.path, this.#storage);
		const header = loaded.entries[0];
		if (!header || header.type !== "session") return undefined;
		const entries = loaded.entries.slice(1) as SessionEntry[];
		const ids = this.#ids(header.id);
		let events: SessionTreeEvent[];
		let graphInvalid = false;
		try {
			events = buildEvents(ids.origin, entries);
		} catch {
			events = [];
			graphInvalid = true;
		}
		const headHash = events.at(-1)?.eventHash ?? null;
		const metadata = metadataRevisionId(header as unknown as CanonicalValue);
		const version = versionId({ originId: ids.origin, headHash, metadataRevisionId: metadata });
		return {
			path: info.path,
			events,
			header: {
				identity: {
					originId: ids.origin,
					branchId: ids.branch,
					versionId: version,
					replicaId: this.replicaId,
					sourceAliases: [ids.alias],
					forkPointHash: null,
					parentVersionId: null,
					headHash,
				},
				header: header as SessionHeader,
				createdAt: info.created.toISOString(),
				modifiedAt: info.modified.toISOString(),
				messageCount: info.messageCount,
				entryCount: entries.length,
				payloadBytes: info.size,
				disposition: loaded.malformedRecords === 0 && !graphInvalid ? "resumable" : "quarantined",
			},
		};
	}

	async #headers(): Promise<JsonlHeaderIndex[]> {
		const headers: JsonlHeaderIndex[] = [];
		for (const info of await listSessions(this.#sessionDir, this.#storage)) {
			const session = await this.#loadSession(info);
			if (session) headers.push({ path: session.path, header: session.header });
		}
		return headers;
	}

	async #findSession(branch: BranchId): Promise<IndexedJsonlSession | undefined> {
		for (const info of await listSessions(this.#sessionDir, this.#storage)) {
			if (this.#ids(info.id).branch !== branch) continue;
			return await this.#loadSession(info);
		}
		return undefined;
	}

	async pathForBranch(branch: BranchId): Promise<string | undefined> {
		for (const info of await listSessions(this.#sessionDir, this.#storage)) {
			if (this.#ids(info.id).branch === branch) return info.path;
		}
		return undefined;
	}
}

