import { TITLE_CHANGE_ENTRY_TYPE, type TitleChangeEntry } from "../../session-entries";
import { canonicalSerialize } from "../canonical";
import {
	computeEventIdentity,
	computeOriginIdentity,
	computeSourceAlias,
	computeVersionIdentity,
} from "../identity";
import type {
	BranchId,
	ConsumeDraftRequest,
	DropSessionRequest,
	EventHash,
	ListRelatedResourcesQuery,
	ModeGeneration,
	PayloadDescriptor,
	PayloadHash,
	ReadPayloadRequest,
	RegisterRelatedResourceRequest,
	RelatedResourceBinding,
	RelatedResourceLocator,
	RelocateSessionRequest,
	ReplicaId,
	RepositoryEvent,
	RepositorySessionHeader,
	RepositoryTreeNode,
	SaveDraftRequest,
	SessionDraft,
	SessionLocator,
	SessionSearchHit,
	SetSessionPinnedRequest,
	SetTerminalSessionPointerRequest,
	SourceIdentity,
	TerminalSessionPointer,
	UpdateSessionTitleRequest,
	WriteCheckpointRequest,
	WritePayloadRequest,
} from "../types";
import { openLocalTursoDatabase, tursoDatabaseModeCanActivate, type OpenLocalTursoDatabaseOptions, type TursoDatabase, type TursoTransaction } from "./database";
import { searchTursoDocuments, upsertTursoSearchDocument } from "./fts";
import type {
	TursoAppendMutation,
	TursoAppendMutationResult,
	TursoCreateMutation,
	TursoDurableFlushReceipt,
	TursoForkMutation,
	TursoKeysetRow,
	TursoPageRequest,
	TursoRuntimeAdapter,
	TursoRuntimeTransaction,
} from "./repository";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CANONICALIZER_VERSION = 1;
const PAYLOAD_CODEC_VERSION = 1;
const MAINTENANCE_PREFIX = "runtime:";

interface HeaderRow {
	origin_id: string;
	branch_id: string;
	version_id: string;
	head_hash: string | null;
	fork_point_hash: string | null;
	parent_version_id: string | null;
	generation: number | bigint;
	created_at: number | bigint;
	modified_at: number | bigint;
	source_namespace: string;
	native_id: string;
	metadata_json: Uint8Array | ArrayBuffer;
}

interface EventRow {
	event_hash: string;
	origin_id: string;
	parent_hash: string | null;
	native_entry_id: string;
	timestamp: number | bigint;
	entry_json: Uint8Array | ArrayBuffer;
	generation?: number | bigint;
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function bytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function jsonBytes(value: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

function parseJson<T>(value: Uint8Array | ArrayBuffer): T {
	return JSON.parse(decoder.decode(bytes(value))) as T;
}
function eventSemanticPayload(entry: RepositoryEvent["entry"]): Record<string, unknown> {
	const { id: _id, parentId: _parentId, ...payload } = entry;
	return payload;
}
function semanticMetadataFromHeader(header: TursoCreateMutation["request"]["header"]): RepositorySessionHeader["metadata"] {
	const metadata: RepositorySessionHeader["metadata"] = { createdAt: header.timestamp };
	if (header.title !== undefined) metadata.title = header.title;
	if (header.titleSource !== undefined) metadata.titleSource = header.titleSource;
	if (header.cwd !== "") metadata.cwd = header.cwd;
	if (header.additionalDirectories !== undefined) metadata.additionalDirectories = [...header.additionalDirectories];
	if (header.providerPromptCacheKey !== undefined) metadata.providerPromptCacheKey = header.providerPromptCacheKey;
	return metadata;
}

function timestamp(value: string): number {
	const parsed = Date.parse(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid repository timestamp: ${value}`);
	return parsed;
}

function sourceNamespace(source: SourceIdentity): string {
	return JSON.stringify([source.sourceNamespace, source.installationNamespace]);
}

function decodeSourceNamespace(value: string, nativeId: string): SourceIdentity {
	const decoded: unknown = JSON.parse(value);
	if (
		!Array.isArray(decoded) ||
		decoded.length !== 2 ||
		typeof decoded[0] !== "string" ||
		typeof decoded[1] !== "string"
	) {
		throw new Error("Stored Turso source namespace is invalid");
	}
	return { sourceNamespace: decoded[0], installationNamespace: decoded[1], nativeId };
}

function metadataId(originId: string, metadata: unknown): string {
	return `metadata_v1_${sha256(canonicalSerialize({ originId, metadata }))}`;
}

function payloadId(hash: string): string {
	return `payload_v1_${hash}`;
}

function position(sortKey: string, id: string) {
	return { sortKey, id };
}
function relatedStateKey(locator: RelatedResourceLocator): string {
	return `related:${encodeURIComponent(locator.owner.branchId)}:${encodeURIComponent(locator.kind)}:${encodeURIComponent(locator.key)}`;
}
function paddedTime(value: number | bigint): string {
	return Number(value).toString().padStart(16, "0");
}
function isTextContentPart(value: unknown): value is { type: "text"; text: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "text" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

function entryText(entry: RepositoryEvent["entry"]): { role: string; text: string } | undefined {
	if (entry.type !== "message" || !("content" in entry.message)) return undefined;
	const role = entry.message.role;
	const content = entry.message.content;
	if (typeof content === "string") return { role, text: content };
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap(part => (isTextContentPart(part) ? [part.text] : [])).join("\n");
	return text ? { role, text } : undefined;
}

async function putPayload(writer: Pick<TursoTransaction, "run">, value: Uint8Array, mediaType?: string): Promise<PayloadDescriptor> {
	const contentHash = sha256(value);
	const id = payloadId(contentHash);
	await writer.run(
		`INSERT OR IGNORE INTO payloads(payload_id, content_hash, codec, codec_version, uncompressed_length, stored_length, chunk_count, media_type, created_at)
		 VALUES (?, ?, 'identity', ?, ?, ?, 1, ?, ?)`,
		id,
		contentHash,
		PAYLOAD_CODEC_VERSION,
		value.byteLength,
		value.byteLength,
		mediaType ?? null,
		Date.now(),
	);
	await writer.run(
		"INSERT OR IGNORE INTO payload_chunks(payload_id, chunk_index, chunk_hash, data) VALUES (?, 0, ?, ?)",
		id,
		contentHash,
		value,
	);
	return { payloadHash: contentHash as PayloadHash, byteLength: value.byteLength, mediaType };
}

async function putMetadata(
	writer: Pick<TursoTransaction, "run">,
	originId: string,
	metadata: RepositorySessionHeader["metadata"],
): Promise<string> {
	const serialized = jsonBytes(metadata);
	const descriptor = await putPayload(writer, serialized, "application/json");
	const id = metadataId(originId, metadata);
	await writer.run(
		`INSERT OR IGNORE INTO metadata_revisions(metadata_revision_id, origin_id, payload_id, semantic_hash, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		id,
		originId,
		payloadId(descriptor.payloadHash),
		sha256(canonicalSerialize(metadata)),
		Date.now(),
	);
	return id;
}

async function loadHeader(reader: Pick<TursoDatabase | TursoTransaction, "get">, branchId: BranchId): Promise<HeaderRow | undefined> {
	return reader.get<HeaderRow>(
		`SELECT b.origin_id, b.branch_id, v.version_id, b.head_hash, b.fork_point_hash,
		        v.parent_version_id, b.generation, b.created_at, v.created_at AS modified_at,
		        sa.source_namespace, sa.native_id, pc.data AS metadata_json
		 FROM branches b
		 JOIN versions v ON v.version_id = b.head_version_id
		 JOIN metadata_revisions mr ON mr.metadata_revision_id = v.metadata_revision_id
		 JOIN payload_chunks pc ON pc.payload_id = mr.payload_id AND pc.chunk_index = 0
		 JOIN source_aliases sa ON sa.origin_id = b.origin_id
		 WHERE b.branch_id = ?
		 ORDER BY sa.observed_at ASC
		 LIMIT 1`,
		branchId,
	);
}

function mapHeader(row: HeaderRow, replicaId: ReplicaId): RepositorySessionHeader {
	const source = decodeSourceNamespace(row.source_namespace, row.native_id);
	return {
		originId: row.origin_id as RepositorySessionHeader["originId"],
		branchId: row.branch_id as BranchId,
		versionId: row.version_id as RepositorySessionHeader["versionId"],
		sourceAlias: computeSourceAlias(source).id,
		replicaId,
		headEventHash: row.head_hash as EventHash | null,
		forkPointHash: row.fork_point_hash as EventHash | null,
		parentVersionId: row.parent_version_id as RepositorySessionHeader["parentVersionId"],
		generation: Number(row.generation),
		metadata: parseJson(row.metadata_json),
		modifiedAt: new Date(Number(row.modified_at)).toISOString(),
	};
}

async function ancestry(
	reader: Pick<TursoDatabase | TursoTransaction, "get">,
	head: EventHash | null,
	limit = 200_001,
): Promise<EventRow[]> {
	const reversed: EventRow[] = [];
	const seen = new Set<string>();
	let cursor: EventHash | null = head;
	while (cursor !== null) {
		if (reversed.length >= limit) throw new Error(`Turso ancestry exceeds the ${limit}-event bound`);
		if (seen.has(cursor)) throw new Error(`Turso ancestry cycle detected at ${cursor}`);
		seen.add(cursor);
		const row = await reader.get<EventRow>(
			`SELECT e.event_hash, e.origin_id, e.parent_hash, e.native_entry_id, e.timestamp, pc.data AS entry_json
			 FROM events e JOIN payload_chunks pc ON pc.payload_id = e.payload_id AND pc.chunk_index = 0
			 WHERE e.event_hash = ?`,
			cursor,
		);
		if (!row) throw new Error(`Turso ancestry is missing event ${cursor}`);
		reversed.push(row);
		cursor = row.parent_hash as EventHash | null;
	}
	reversed.reverse();
	return reversed;
}

function mapEvents(rows: readonly EventRow[]): RepositoryEvent[] {
	return rows.map((row, index) => ({
		eventHash: row.event_hash as EventHash,
		originId: row.origin_id as RepositoryEvent["originId"],
		parentEventHash: row.parent_hash as EventHash | null,
		nativeEntryId: row.native_entry_id,
		generation: row.generation === undefined ? index : Number(row.generation),
		entry: parseJson(row.entry_json),
	}));
}

async function stateGet<T>(reader: Pick<TursoDatabase | TursoTransaction, "get">, key: string): Promise<T | undefined> {
	const row = await reader.get<{ value: string }>("SELECT value FROM maintenance_state WHERE name = ?", `${MAINTENANCE_PREFIX}${key}`);
	return row ? (JSON.parse(row.value) as T) : undefined;
}

async function statePut(writer: Pick<TursoTransaction, "run">, key: string, value: unknown): Promise<void> {
	await writer.run(
		`INSERT INTO maintenance_state(name, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		`${MAINTENANCE_PREFIX}${key}`,
		JSON.stringify(value),
		Date.now(),
	);
}

async function stateDelete(writer: Pick<TursoTransaction, "run">, key: string): Promise<void> {
	await writer.run("DELETE FROM maintenance_state WHERE name = ?", `${MAINTENANCE_PREFIX}${key}`);
}

class EmbeddedTransaction implements TursoRuntimeTransaction {
	constructor(
		private readonly transaction: TursoTransaction,
		private readonly adapter: EmbeddedTursoRuntimeAdapter,
	) {}

	async assertModeGeneration(expected: ModeGeneration): Promise<void> {
		const row = await this.transaction.get<{ token: string }>("SELECT token FROM storage_fences WHERE replica_id = ?", this.adapter.replicaId);
		if (!row || row.token !== expected) throw new Error("Stale Turso mode generation");
	}

	async getHeader(branchId: BranchId): Promise<RepositorySessionHeader | undefined> {
		if (await stateGet(this.transaction, `dropped:${branchId}`)) return undefined;
		const row = await loadHeader(this.transaction, branchId);
		return row ? mapHeader(row, this.adapter.replicaId) : undefined;
	}

	async isEventReachable(branchId: BranchId, eventHash: EventHash | null): Promise<boolean> {
		if (eventHash === null) return true;
		const header = await this.getHeader(branchId);
		if (!header) return false;
		return (await ancestry(this.transaction, header.headEventHash)).some(row => row.event_hash === eventHash);
	}

	async createSession(mutation: TursoCreateMutation): Promise<RepositorySessionHeader> {
		const { request, originId, sourceAlias, targetBranchId } = mutation;
		const createdAt = timestamp(request.header.timestamp);
		const namespace = sourceNamespace(request.source);
		await this.transaction.run(
			"INSERT OR IGNORE INTO origins(origin_id, source_namespace, native_id, created_at) VALUES (?, ?, ?, ?)",
			originId,
			namespace,
			request.source.nativeId,
			createdAt,
		);
		await this.transaction.run(
			"INSERT OR IGNORE INTO source_aliases(source_namespace, native_id, origin_id, observed_at) VALUES (?, ?, ?, ?)",
			namespace,
			request.source.nativeId,
			originId,
			createdAt,
		);
		if (computeSourceAlias(request.source).id !== sourceAlias) throw new Error("Source alias identity changed");
		await statePut(this.transaction, `source-alias:${sourceAlias}`, originId);
		const metadata = request.metadata ?? semanticMetadataFromHeader(request.header);
		const metadataRevisionId = await putMetadata(this.transaction, originId, metadata);
		const versionId = computeVersionIdentity({ originId, headEventHash: null, treeEventHashes: [], metadata }).id;
		await this.transaction.run(
			`INSERT INTO branches(branch_id, origin_id, parent_branch_id, fork_point_hash, head_hash, head_version_id, generation, created_at)
			 VALUES (?, ?, NULL, NULL, NULL, NULL, 0, ?)`,
			targetBranchId,
			originId,
			createdAt,
		);
		await this.transaction.run(
			`INSERT INTO versions(version_id, origin_id, branch_id, parent_version_id, head_hash, metadata_revision_id, created_at)
			 VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
			versionId,
			originId,
			targetBranchId,
			metadataRevisionId,
			createdAt,
		);
		await this.transaction.run("UPDATE branches SET head_version_id = ? WHERE branch_id = ?", versionId, targetBranchId);
		const header = await this.getHeader(targetBranchId);
		if (!header) throw new Error("Turso session creation did not publish a header");
		return header;
	}

	async append(mutation: TursoAppendMutation): Promise<TursoAppendMutationResult> {
		const parent = await this.getHeader(mutation.request.branchId);
		if (!parent) throw new Error(`Unknown Turso branch ${mutation.request.branchId}`);
		let parentHash = mutation.request.expectedHeadHash;
		const eventHashes: EventHash[] = [];
		for (const entry of mutation.request.entries) {
			const proof = computeEventIdentity({
				originId: parent.originId,
				nativeEntryId: entry.id,
				parentEventHash: parentHash,
				semanticPayload: eventSemanticPayload(entry),
			});
			const serialized = jsonBytes(entry);
			const descriptor = await putPayload(this.transaction, serialized, "application/json");
			await this.transaction.run(
				`INSERT OR IGNORE INTO events(event_hash, origin_id, parent_hash, native_entry_id, kind, timestamp, payload_id, canonicalizer_version, canonical_length)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				proof.id,
				parent.originId,
				parentHash,
				entry.id,
				entry.type,
				timestamp(entry.timestamp),
				payloadId(descriptor.payloadHash),
				CANONICALIZER_VERSION,
				proof.canonicalLength,
			);
			const searchable = entryText(entry);
			if (searchable) {
				await upsertTursoSearchDocument(this.transaction, {
					eventHash: proof.id,
					originId: parent.originId,
					role: searchable.role,
					eventTime: timestamp(entry.timestamp),
					text: searchable.text,
				});
			}
			eventHashes.push(proof.id);
			parentHash = proof.id;
		}
		const existingTarget = await this.getHeader(mutation.targetBranchId);
		const metadata = mutation.request.metadata ?? parent.metadata;
		if (
			existingTarget?.headEventHash === parentHash &&
			sha256(canonicalSerialize(existingTarget.metadata)) === sha256(canonicalSerialize(metadata))
		) {
			return { header: existingTarget, changed: false };
		}
		if (!existingTarget) {
			await this.transaction.run(
				`INSERT INTO branches(branch_id, origin_id, parent_branch_id, fork_point_hash, head_hash, head_version_id, generation, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
				mutation.targetBranchId,
				parent.originId,
				mutation.parentBranchId,
				mutation.forkPointHash,
				mutation.request.expectedHeadHash,
				parent.versionId,
				Date.now(),
			);
		}
		const baseRows = await ancestry(this.transaction, mutation.request.expectedHeadHash);
		if (!existingTarget) {
			for (let generation = 0; generation < baseRows.length; generation++) {
				await this.transaction.run(
					"INSERT INTO branch_events(branch_id, generation, event_hash) VALUES (?, ?, ?)",
					mutation.targetBranchId,
					generation,
					baseRows[generation].event_hash,
				);
			}
		}
		for (let index = 0; index < eventHashes.length; index++) {
			await this.transaction.run(
				"INSERT OR IGNORE INTO branch_events(branch_id, generation, event_hash) VALUES (?, ?, ?)",
				mutation.targetBranchId,
				baseRows.length + index,
				eventHashes[index],
			);
		}
		const treeEventHashes = [...baseRows.map(row => row.event_hash as EventHash), ...eventHashes];
		const metadataRevisionId = await putMetadata(this.transaction, parent.originId, metadata);
		const version = computeVersionIdentity({ originId: parent.originId, headEventHash: parentHash, treeEventHashes, metadata });
		const versionCreatedAt = timestamp(mutation.request.entries.at(-1)?.timestamp ?? existingTarget?.modifiedAt ?? parent.modifiedAt);
		await this.transaction.run(
			`INSERT OR IGNORE INTO versions(version_id, origin_id, branch_id, parent_version_id, head_hash, metadata_revision_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			version.id,
			parent.originId,
			mutation.targetBranchId,
			existingTarget?.versionId ?? parent.versionId,
			parentHash,
			metadataRevisionId,
			versionCreatedAt,
		);
		const result = await this.transaction.run(
			`UPDATE branches SET head_hash = ?, head_version_id = ?, generation = ?
			 WHERE branch_id = ? AND head_hash IS ?`,
			parentHash,
			version.id,
			Math.max(0, treeEventHashes.length - 1),
			mutation.targetBranchId,
			existingTarget?.headEventHash ?? mutation.request.expectedHeadHash,
		);
		if (result.changes !== 1) throw new Error("Turso branch head changed during fenced append");
		const header = await this.getHeader(mutation.targetBranchId);
		if (!header) throw new Error("Turso append did not publish a header");
		return { header, changed: true };
	}

	async fork(mutation: TursoForkMutation): Promise<RepositorySessionHeader> {
		const parent = await this.getHeader(mutation.request.branchId);
		if (!parent) throw new Error(`Unknown Turso branch ${mutation.request.branchId}`);
		const existing = await this.getHeader(mutation.targetBranchId);
		if (existing) return existing;
		const metadata = mutation.request.metadata ?? parent.metadata;
		const tree = await ancestry(this.transaction, mutation.request.atEventHash);
		const version = computeVersionIdentity({
			originId: parent.originId,
			headEventHash: mutation.request.atEventHash,
			treeEventHashes: tree.map(row => row.event_hash as EventHash),
			metadata,
		});
		const metadataRevisionId = await putMetadata(this.transaction, parent.originId, metadata);
		await this.transaction.run(
			`INSERT INTO branches(branch_id, origin_id, parent_branch_id, fork_point_hash, head_hash, head_version_id, generation, created_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
			mutation.targetBranchId,
			parent.originId,
			parent.branchId,
			mutation.request.atEventHash,
			mutation.request.atEventHash,
			Math.max(0, tree.length - 1),
			Date.now(),
		);
		for (let generation = 0; generation < tree.length; generation++) {
			await this.transaction.run(
				"INSERT INTO branch_events(branch_id, generation, event_hash) VALUES (?, ?, ?)",
				mutation.targetBranchId,
				generation,
				tree[generation].event_hash,
			);
		}
		await this.transaction.run(
			`INSERT OR IGNORE INTO versions(version_id, origin_id, branch_id, parent_version_id, head_hash, metadata_revision_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			version.id,
			parent.originId,
			mutation.targetBranchId,
			parent.versionId,
			mutation.request.atEventHash,
			metadataRevisionId,
			Date.now(),
		);
		await this.transaction.run("UPDATE branches SET head_version_id = ? WHERE branch_id = ?", version.id, mutation.targetBranchId);
		const header = await this.getHeader(mutation.targetBranchId);
		if (!header) throw new Error("Turso fork did not publish a header");
		return header;
	}

	async updateTitle(request: UpdateSessionTitleRequest): Promise<RepositorySessionHeader> {
		const current = await this.getHeader(request.branchId);
		if (!current || current.headEventHash !== request.expectedHeadHash) {
			throw new Error("Turso title update lost expected-head CAS");
		}
		const metadata = {
			...current.metadata,
			extensions: { ...current.metadata.extensions, titleUpdatedAt: request.updatedAt },
		};
		if (request.title === undefined) delete metadata.title;
		else metadata.title = request.title;
		if (request.source === undefined) delete metadata.titleSource;
		else metadata.titleSource = request.source;
		const eventSource = request.source ?? current.metadata.titleSource ?? "user";
		const tree = await ancestry(this.transaction, request.expectedHeadHash);
		const nativeParentId = request.expectedHeadHash === null ? null : (tree.at(-1)?.native_entry_id ?? null);
		const digest = new Bun.CryptoHasher("sha256")
			.update(
				JSON.stringify([
					current.branchId,
					request.expectedHeadHash,
					request.updatedAt,
					request.title ?? null,
					eventSource,
				]),
			)
			.digest("hex");
		const titleChange: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			id: `title-change-${digest.slice(0, 32)}`,
			parentId: nativeParentId,
			timestamp: request.updatedAt,
			title: request.title ?? "",
			source: eventSource,
			...(current.metadata.title === undefined ? {} : { previousTitle: current.metadata.title }),
		};
		return (
			await this.append({
				request: { ...request, entries: [titleChange], metadata },
				targetBranchId: current.branchId,
				parentBranchId: null,
				forkPointHash: current.forkPointHash,
			})
		).header;
	}

	async drop(request: DropSessionRequest): Promise<boolean> {
		const current = await this.getHeader(request.locator.branchId);
		if (!current) return false;
		if (request.locator.versionId && request.locator.versionId !== current.versionId) {
			throw new Error("Drop locator version is stale");
		}
		await statePut(this.transaction, `dropped:${current.branchId}`, { versionId: current.versionId, droppedAt: new Date().toISOString() });
		await stateDelete(this.transaction, `draft:${current.branchId}`);
		await stateDelete(this.transaction, `location:${current.branchId}`);
		await stateDelete(this.transaction, `pinned:${current.branchId}`);
		return true;
	}

	async relocate(request: RelocateSessionRequest): Promise<SessionLocator> {
		const current = await this.getHeader(request.locator.branchId);
		if (!current) throw new Error(`Unknown Turso branch ${request.locator.branchId}`);
		if (request.locator.versionId && request.locator.versionId !== current.versionId) {
			throw new Error("Relocation locator version is stale");
		}
		await statePut(this.transaction, `location:${current.branchId}`, request.logicalLocation);
		return { branchId: current.branchId, versionId: current.versionId };
	}

	async saveDraft(request: SaveDraftRequest): Promise<SessionDraft> {
		if (!(await this.getHeader(request.draft.branchId))) {
			throw new Error(`Unknown Turso branch ${request.draft.branchId}`);
		}
		const payload = await this.transaction.get<{ payload_id: string }>(
			"SELECT payload_id FROM payloads WHERE content_hash = ?",
			request.draft.payloadHash,
		);
		if (!payload) throw new Error(`Unknown Turso draft payload ${request.draft.payloadHash}`);
		const key = `draft:${request.draft.branchId}`;
		const existing = await stateGet<SessionDraft>(this.transaction, key);
		if ((existing?.revision ?? null) !== request.expectedRevision) throw new Error("Turso draft revision conflict");
		await statePut(this.transaction, key, request.draft);
		return request.draft;
	}

	async consumeDraft(request: ConsumeDraftRequest): Promise<SessionDraft | undefined> {
		const key = `draft:${request.branchId}`;
		const existing = await stateGet<SessionDraft>(this.transaction, key);
		if (!existing) return undefined;
		if (request.expectedRevision !== undefined && existing.revision !== request.expectedRevision) {
			throw new Error("Turso draft revision conflict");
		}
		await stateDelete(this.transaction, key);
		return existing;
	}

	async registerRelatedResource(request: RegisterRelatedResourceRequest): Promise<void> {
		if (!(await this.getHeader(request.locator.owner.branchId)) || !(await this.getHeader(request.target.branchId))) {
			throw new Error("Related resource locator references an unknown Turso branch");
		}
		const locator = { ...request.locator, owner: { branchId: request.locator.owner.branchId } };
		await statePut(this.transaction, relatedStateKey(locator), {
			locator,
			target: { branchId: request.target.branchId },
		} satisfies RelatedResourceBinding);
	}

	async setTerminalSessionPointer(request: SetTerminalSessionPointerRequest): Promise<void> {
		if (!(await this.getHeader(request.pointer.session.branchId))) {
			throw new Error(`Unknown Turso branch ${request.pointer.session.branchId}`);
		}
		await statePut(this.transaction, `terminal:${request.pointer.terminalId}`, request.pointer);
	}

	async setPinned(request: SetSessionPinnedRequest): Promise<void> {
		if (!(await this.getHeader(request.branchId))) throw new Error(`Unknown Turso branch ${request.branchId}`);
		if (request.pinned) await statePut(this.transaction, `pinned:${request.branchId}`, true);
		else await stateDelete(this.transaction, `pinned:${request.branchId}`);
	}

	async putCheckpoint(request: WriteCheckpointRequest): Promise<void> {
		if (request.checkpoint.headEventHash === null) throw new Error("Turso checkpoints require a non-empty head");
		const header = await this.getHeader(request.checkpoint.branchId);
		if (!header) throw new Error("Unknown checkpoint branch");
		if (header.headEventHash !== request.checkpoint.headEventHash) {
			throw new Error("Checkpoint head is not the current Turso branch head");
		}
		const revision = metadataId(header.originId, header.metadata);
		await this.transaction.run(
			`INSERT INTO checkpoints(checkpoint_key, branch_id, head_hash, metadata_revision_id, context_builder_version, context_hash, payload_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(checkpoint_key) DO UPDATE SET context_hash = excluded.context_hash, payload_id = excluded.payload_id, created_at = excluded.created_at`,
			request.checkpoint.checkpointId,
			request.checkpoint.branchId,
			request.checkpoint.headEventHash,
			revision,
			request.checkpoint.contextBuilderVersion,
			request.checkpoint.contextHash,
			payloadId(request.checkpoint.payloadHash),
			timestamp(request.checkpoint.createdAt),
		);
	}
}

export interface EmbeddedTursoRuntimeAdapterOptions {
	database: TursoDatabase;
	replicaId: ReplicaId;
	modeGeneration: ModeGeneration;
}

export class EmbeddedTursoRuntimeAdapter implements TursoRuntimeAdapter {
	readonly replicaId: ReplicaId;
	readonly #database: TursoDatabase;
	readonly #modeGeneration: ModeGeneration;
	#closed = false;

	private constructor(options: EmbeddedTursoRuntimeAdapterOptions) {
		this.#database = options.database;
		this.replicaId = options.replicaId;
		this.#modeGeneration = options.modeGeneration;
	}

	static async create(options: EmbeddedTursoRuntimeAdapterOptions): Promise<EmbeddedTursoRuntimeAdapter> {
		if (options.database.readonly) throw new Error("Turso runtime adapter requires a writable local database");
		await options.database.run(
			"INSERT OR IGNORE INTO storage_fences(replica_id, generation, token, committed_sequence, updated_at) VALUES (?, 0, ?, 0, ?)",
			options.replicaId,
			options.modeGeneration,
			Date.now(),
		);
		const row = await options.database.get<{ token: string }>("SELECT token FROM storage_fences WHERE replica_id = ?", options.replicaId);
		if (row?.token !== options.modeGeneration) throw new Error("Turso runtime mode generation does not match persisted fence");
		return new EmbeddedTursoRuntimeAdapter(options);
	}

	async transaction<T>(work: (transaction: TursoRuntimeTransaction) => Promise<T>): Promise<T> {
		this.#assertOpen();
		return this.#database.transactionAsync(transaction => work(new EmbeddedTransaction(transaction, this)));
	}

	async listSessions(query: TursoPageRequest & { originId?: RepositorySessionHeader["originId"]; sourceAlias?: RepositorySessionHeader["sourceAlias"] }): Promise<readonly TursoKeysetRow<RepositorySessionHeader>[]> {
		this.#assertOpen();
		const clauses: string[] = [
			"NOT EXISTS (SELECT 1 FROM maintenance_state m WHERE m.name = ? || b.branch_id)",
		];
		const parameters: unknown[] = [`${MAINTENANCE_PREFIX}dropped:`];
		let selectedOrigin = query.originId;
		if (query.sourceAlias) {
			const aliasOrigin = await stateGet<RepositorySessionHeader["originId"]>(
				this.#database,
				`source-alias:${query.sourceAlias}`,
			);
			if (!aliasOrigin || (selectedOrigin && selectedOrigin !== aliasOrigin)) return [];
			selectedOrigin = aliasOrigin;
		}
		if (selectedOrigin) {
			clauses.push("b.origin_id = ?");
			parameters.push(selectedOrigin);
		}
		if (query.after) {
			clauses.push("(v.created_at > ? OR (v.created_at = ? AND b.branch_id > ?))");
			parameters.push(Number(query.after.sortKey), Number(query.after.sortKey), query.after.id);
		}
		const rows = await this.#database.all<HeaderRow>(
			`SELECT b.origin_id, b.branch_id, v.version_id, b.head_hash, b.fork_point_hash, v.parent_version_id,
			        b.generation, b.created_at, v.created_at AS modified_at, sa.source_namespace, sa.native_id, pc.data AS metadata_json
			 FROM branches b JOIN versions v ON v.version_id = b.head_version_id
			 JOIN metadata_revisions mr ON mr.metadata_revision_id = v.metadata_revision_id
			 JOIN payload_chunks pc ON pc.payload_id = mr.payload_id AND pc.chunk_index = 0
			 JOIN source_aliases sa ON sa.origin_id = b.origin_id
			 ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
			 ORDER BY v.created_at ASC, b.branch_id ASC LIMIT ?`,
			...parameters,
			query.limit,
		);
		return rows.map(row => ({ value: mapHeader(row, this.replicaId), position: position(paddedTime(row.modified_at), row.branch_id) }));
	}

	async search(query: TursoPageRequest & { text: string; originId?: RepositorySessionHeader["originId"] }): Promise<readonly TursoKeysetRow<SessionSearchHit>[]> {
		this.#assertOpen();
		let offset = query.after ? Number(query.after.sortKey) : 0;
		if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Turso search cursor");
		const rows: TursoKeysetRow<SessionSearchHit>[] = [];
		while (rows.length < query.limit) {
			const page = await searchTursoDocuments(this.#database, {
				query: query.text,
				limit: Math.min(100, query.limit - rows.length),
				offset,
				originId: query.originId,
			});
			for (let index = 0; index < page.hits.length && rows.length < query.limit; index++) {
				const hit = page.hits[index];
				const rawPosition = offset + index + 1;
				const branch = await this.#database.get<{ branch_id: string }>(
					`SELECT b.branch_id FROM branch_events be JOIN branches b ON b.branch_id = be.branch_id
					 WHERE be.event_hash = ? AND b.origin_id = ?
					   AND NOT EXISTS (
						   SELECT 1 FROM maintenance_state ms
						   WHERE ms.name = ? || b.branch_id
					   )
					 ORDER BY b.generation DESC, b.branch_id ASC LIMIT 1`,
					hit.eventHash,
					hit.originId,
					`${MAINTENANCE_PREFIX}dropped:`,
				);
				if (!branch) continue;
				const header = await this.getHeader(branch.branch_id as BranchId);
				if (!header) continue;
				rows.push({
					value: { header, eventHash: hit.eventHash as EventHash, snippet: hit.highlightedText },
					position: position(String(rawPosition), hit.eventHash),
				});
			}
			if (rows.length >= query.limit || page.nextOffset === undefined) break;
			offset = page.nextOffset;
		}
		return rows;
	}

	async readTree(query: TursoPageRequest & { branchId: BranchId; versionId?: RepositorySessionHeader["versionId"] }): Promise<readonly TursoKeysetRow<RepositoryTreeNode>[]> {
		const events = await this.readEvents(query);
		const maximum = query.versionId
			? await this.#database.get<{ generation: number | bigint }>(
					`SELECT be.generation FROM versions v
					 JOIN branch_events be ON be.branch_id = v.branch_id AND be.event_hash = v.head_hash
					 WHERE v.version_id = ? AND v.branch_id = ?`,
					query.versionId,
					query.branchId,
				)
			: undefined;
		const maximumGeneration = maximum ? Number(maximum.generation) : Number.MAX_SAFE_INTEGER;
		const output: TursoKeysetRow<RepositoryTreeNode>[] = [];
		for (const row of events) {
			const children = await this.#database.all<{ event_hash: string }>(
				`SELECT e.event_hash FROM events e
				 JOIN branch_events be ON be.event_hash = e.event_hash
				 WHERE e.parent_hash = ? AND be.branch_id = ? AND be.generation <= ?
				 ORDER BY e.event_hash`,
				row.value.eventHash,
				query.branchId,
				maximumGeneration,
			);
			output.push({
				value: { ...row.value, childEventHashes: children.map(child => child.event_hash as EventHash) },
				position: row.position,
			});
		}
		return output;
	}

	async readEvents(query: TursoPageRequest & { branchId: BranchId; versionId?: RepositorySessionHeader["versionId"] }): Promise<readonly TursoKeysetRow<RepositoryEvent>[]> {
		this.#assertOpen();
		let maximumGeneration: number;
		if (query.versionId) {
			const version = await this.#database.get<{ generation: number | bigint }>(
				`SELECT be.generation FROM versions v
				 JOIN branch_events be ON be.branch_id = v.branch_id AND be.event_hash = v.head_hash
				 WHERE v.version_id = ? AND v.branch_id = ?`,
				query.versionId,
				query.branchId,
			);
			if (!version) return [];
			maximumGeneration = Number(version.generation);
		} else {
			const header = await this.getHeader(query.branchId);
			if (!header || header.headEventHash === null) return [];
			maximumGeneration = header.generation;
		}
		const afterGeneration = query.after ? Number(query.after.sortKey) : -1;
		if (!Number.isSafeInteger(afterGeneration) || afterGeneration < -1) throw new Error("Invalid Turso event cursor");
		const rows = await this.#database.all<EventRow>(
			`SELECT e.event_hash, e.origin_id, e.parent_hash, e.native_entry_id, e.timestamp,
			        pc.data AS entry_json, be.generation
			 FROM branch_events be JOIN events e ON e.event_hash = be.event_hash
			 JOIN payload_chunks pc ON pc.payload_id = e.payload_id AND pc.chunk_index = 0
			 WHERE be.branch_id = ? AND be.generation > ? AND be.generation <= ?
			 ORDER BY be.generation LIMIT ?`,
			query.branchId,
			afterGeneration,
			maximumGeneration,
			query.limit,
		);
		return mapEvents(rows).map(event => ({
			value: event,
			position: position(paddedTime(event.generation), event.eventHash),
		}));
	}

	async listRelatedResources(query: TursoPageRequest & Pick<ListRelatedResourcesQuery, "owner" | "kind">): Promise<readonly TursoKeysetRow<RelatedResourceBinding>[]> {
		const prefix = `${MAINTENANCE_PREFIX}related:${encodeURIComponent(query.owner.branchId)}:${query.kind ? `${encodeURIComponent(query.kind)}:` : ""}`;
		const parameters: unknown[] = [prefix, `${prefix}\uffff`];
		const after = query.after ? " AND name > ?" : "";
		if (query.after) parameters.push(query.after.sortKey);
		parameters.push(query.limit);
		const rows = await this.#database.all<{ name: string; value: string }>(
			`SELECT name, value FROM maintenance_state WHERE name >= ? AND name < ?${after} ORDER BY name LIMIT ?`,
			...parameters,
		);
		return rows.map(row => ({
			value: JSON.parse(row.value) as RelatedResourceBinding,
			position: position(row.name, row.name),
		}));
	}

	async getHeader(branchId: BranchId): Promise<RepositorySessionHeader | undefined> {
		this.#assertOpen();
		if (await stateGet(this.#database, `dropped:${branchId}`)) return undefined;
		const row = await loadHeader(this.#database, branchId);
		return row ? mapHeader(row, this.replicaId) : undefined;
	}

	async *readContextTail(query: { branchId: BranchId; afterEventHash?: EventHash; limit: number }): AsyncIterable<RepositoryEvent> {
		const header = await this.getHeader(query.branchId);
		if (!header || header.headEventHash === null) return;
		let afterGeneration = -1;
		if (query.afterEventHash) {
			const cursor = await this.#database.get<{ generation: number | bigint }>(
				"SELECT generation FROM branch_events WHERE branch_id = ? AND event_hash = ?",
				query.branchId,
				query.afterEventHash,
			);
			if (!cursor) return;
			afterGeneration = Number(cursor.generation);
		}
		const rows = await this.#database.all<EventRow>(
			`SELECT e.event_hash, e.origin_id, e.parent_hash, e.native_entry_id, e.timestamp,
			        pc.data AS entry_json, be.generation
			 FROM branch_events be JOIN events e ON e.event_hash = be.event_hash
			 JOIN payload_chunks pc ON pc.payload_id = e.payload_id AND pc.chunk_index = 0
			 WHERE be.branch_id = ? AND be.generation > ?
			 ORDER BY be.generation LIMIT ?`,
			query.branchId,
			afterGeneration,
			query.limit,
		);
		for (const event of mapEvents(rows)) yield event;
	}

	async writePayload(request: WritePayloadRequest): Promise<PayloadDescriptor> {
		this.#assertOpen();
		if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0) {
			throw new RangeError("maxBytes must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(request.maxChunkBytes) || request.maxChunkBytes < 1) {
			throw new RangeError("maxChunkBytes must be a positive safe integer");
		}
		return this.#database.transactionAsync(async transaction => {
			const fence = await transaction.get<{ token: string }>(
				"SELECT token FROM storage_fences WHERE replica_id = ?",
				this.replicaId,
			);
			if (!fence || fence.token !== request.expectedModeGeneration) {
				throw new Error("Stale Turso mode generation");
			}
			const stage = `payload_stage_${crypto.randomUUID().replaceAll("-", "")}`;
			await transaction.exec(
				`CREATE TEMP TABLE ${stage} (chunk_index INTEGER PRIMARY KEY, chunk_hash TEXT NOT NULL, data BLOB NOT NULL)`,
			);
			const hasher = new Bun.CryptoHasher("sha256");
			let byteLength = 0;
			let chunkCount = 0;
			try {
				for await (const chunk of request.bytes) {
					if (!(chunk instanceof Uint8Array)) throw new TypeError("Payload chunks must be Uint8Array values");
					if (chunk.byteLength > request.maxChunkBytes) {
						throw new RangeError(`Payload chunk exceeds ${request.maxChunkBytes} bytes`);
					}
					if (byteLength + chunk.byteLength > request.maxBytes) {
						throw new RangeError(`Payload exceeds ${request.maxBytes} bytes`);
					}
					if (chunk.byteLength === 0) continue;
					hasher.update(chunk);
					byteLength += chunk.byteLength;
					await transaction.run(
						`INSERT INTO ${stage}(chunk_index, chunk_hash, data) VALUES (?, ?, ?)`,
						chunkCount,
						sha256(chunk),
						chunk,
					);
					chunkCount++;
				}
				const contentHash = hasher.digest("hex");
				const id = payloadId(contentHash);
				await transaction.run(
					`INSERT OR IGNORE INTO payloads(payload_id, content_hash, codec, codec_version, uncompressed_length, stored_length, chunk_count, media_type, created_at)
					 VALUES (?, ?, 'identity', ?, ?, ?, ?, ?, ?)`,
					id,
					contentHash,
					PAYLOAD_CODEC_VERSION,
					byteLength,
					byteLength,
					chunkCount,
					request.mediaType ?? null,
					Date.now(),
				);
				await transaction.run(
					`INSERT OR IGNORE INTO payload_chunks(payload_id, chunk_index, chunk_hash, data)
					 SELECT ?, chunk_index, chunk_hash, data FROM ${stage} ORDER BY chunk_index`,
					id,
				);
				return { payloadHash: contentHash as PayloadHash, byteLength, mediaType: request.mediaType };
			} finally {
				await transaction.exec(`DROP TABLE IF EXISTS ${stage}`);
			}
		});
	}

	async *readPayload(query: {
		payloadHash: ReadPayloadRequest["payloadHash"];
		chunkBytes: number;
	}): AsyncIterable<Uint8Array> {
		this.#assertOpen();
		const id = payloadId(query.payloadHash);
		const payload = await this.#database.get<{ chunk_count: number | bigint }>(
			"SELECT chunk_count FROM payloads WHERE payload_id = ?",
			id,
		);
		if (!payload) throw new Error(`Unknown Turso payload ${query.payloadHash}`);
		for await (const row of this.#database.iterate<{ data: Uint8Array | ArrayBuffer }>(
			"SELECT data FROM payload_chunks WHERE payload_id = ? ORDER BY chunk_index",
			id,
		)) {
			const value = bytes(row.data);
			for (let offset = 0; offset < value.byteLength; offset += query.chunkBytes) {
				yield value.slice(offset, offset + query.chunkBytes);
			}
		}
	}

	async resolveRelatedResource(locator: RelatedResourceLocator): Promise<SessionLocator | undefined> {
		return (await stateGet<RelatedResourceBinding>(this.#database, relatedStateKey(locator)))?.target;
	}

	async getTerminalSessionPointer(terminalId: string): Promise<TerminalSessionPointer | undefined> {
		return stateGet(this.#database, `terminal:${terminalId}`);
	}

	async listPinned(limit: number): Promise<readonly BranchId[]> {
		const prefix = `${MAINTENANCE_PREFIX}pinned:`;
		const rows = await this.#database.all<{ name: string }>("SELECT name FROM maintenance_state WHERE name >= ? AND name < ? ORDER BY name LIMIT ?", prefix, `${prefix}\uffff`, limit);
		return rows.map(row => row.name.slice(prefix.length) as BranchId);
	}

	async flush(expectedModeGeneration: ModeGeneration): Promise<TursoDurableFlushReceipt> {
		this.#assertOpen();
		const sequence = await this.#database.transactionAsync(async transaction => {
			const row = await transaction.get<{ token: string; committed_sequence: number | bigint }>("SELECT token, committed_sequence FROM storage_fences WHERE replica_id = ?", this.replicaId);
			if (!row || row.token !== expectedModeGeneration) throw new Error("Stale Turso mode generation");
			const next = Number(row.committed_sequence) + 1;
			await transaction.run("UPDATE storage_fences SET committed_sequence = ?, updated_at = ? WHERE replica_id = ?", next, Date.now(), this.replicaId);
			return next;
		});
		const checkpoint = await this.#database.checkpoint();
		if (checkpoint.busy !== 0) throw new Error("Turso flush checkpoint remained busy");
		return { modeGeneration: expectedModeGeneration, durable: true, committedSequence: String(sequence), checkpointed: true };
	}

	async health() {
		if (this.#closed || !this.#database.open) return { status: "unavailable" as const, modeGeneration: this.#modeGeneration, writable: false, details: ["Turso database is closed"] };
		const row = await this.#database.get<{ token: string }>("SELECT token FROM storage_fences WHERE replica_id = ?", this.replicaId);
		return { status: row?.token === this.#modeGeneration ? "ok" as const : "degraded" as const, modeGeneration: this.#modeGeneration, writable: row?.token === this.#modeGeneration };
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#database.close();
	}

	#assertOpen(): void {
		if (this.#closed || !this.#database.open) throw new Error("Embedded Turso runtime adapter is closed");
	}
}

export async function createEmbeddedTursoRuntimeAdapter(options: EmbeddedTursoRuntimeAdapterOptions): Promise<EmbeddedTursoRuntimeAdapter> {
	return EmbeddedTursoRuntimeAdapter.create(options);
}

export interface OpenEmbeddedTursoRuntimeAdapterOptions extends OpenLocalTursoDatabaseOptions {
	replicaId: ReplicaId;
	modeGeneration: ModeGeneration;
	capabilityReport: { databaseModeEnabled: boolean };
}

/** Production activation boundary: the native capability receipt must pass before the database is opened. */
export async function openEmbeddedTursoRuntimeAdapter(options: OpenEmbeddedTursoRuntimeAdapterOptions): Promise<EmbeddedTursoRuntimeAdapter> {
	if (!tursoDatabaseModeCanActivate(options.capabilityReport)) {
		throw new Error("Embedded Turso database mode is disabled because native capability gates did not pass");
	}
	const database = await openLocalTursoDatabase(options);
	try {
		return await createEmbeddedTursoRuntimeAdapter({ database, replicaId: options.replicaId, modeGeneration: options.modeGeneration });
	} catch (error) {
		await database.close();
		throw error;
	}
}
