import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionEntry, SessionHeader } from "../session-entries";
import { parseSessionContent } from "../session-loader";
import {
	assertIdentityClaim,
	computeBranchIdentity,
	computeEventIdentity,
	computeOriginIdentity,
	computeSourceAlias,
	computeVersionIdentity,
	IdentityCollisionRegistry,
} from "./identity";
import type {
	AppendWithExpectedHeadRequest,
	AppendWithExpectedHeadResult,
	BranchId,
	ConsumeDraftRequest,
	CreateSessionRequest,
	ContextCheckpoint,
	DropSessionRequest,
	EventHash,
	ExportArchiveQuery,
	FlushRequest,
	ForkRequest,
	GetHeaderRequest,
	ImportArchiveOptions,
	KeysetCursor,
	KeysetPage,
	ListRelatedResourcesQuery,
	ListSessionsQuery,
	ModeGeneration,
	OriginId,
	PayloadDescriptor,
	PayloadHash,
	ReadContextTailRequest,
	ReadEventsQuery,
	ReadPayloadRequest,
	ReadTreeQuery,
	RegisterRelatedResourceRequest,
	RelatedResourceBinding,
	RelatedResourceLocator,
	RelocateSessionRequest,
	ReplicaId,
	RepositoryCapabilities,
	RepositoryEvent,
	RepositoryHealth,
	RepositorySessionHeader,
	RepositoryTreeNode,
	SaveDraftRequest,
	SearchSessionsQuery,
	SessionArchiveItem,
	SessionDraft,
	SessionExportItem,
	SessionImportItem,
	SessionLocator,
	SessionRepository,
	SessionSearchHit,
	SessionSemanticMetadata,
	SessionTransferService,
	SetSessionPinnedRequest,
	SetTerminalSessionPointerRequest,
	SourceAlias,
	SourceIdentity,
	SyncOptions,
	TerminalSessionPointer,
	TransferReport,
	UpdateSessionTitleRequest,
	VersionId,
	WriteCheckpointRequest,
	WritePayloadRequest,
} from "./types";

const MANIFEST_NAME = ".omp-session-repository-v1.json";
const PAYLOAD_DIRECTORY = ".omp-session-payloads-v1";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_PAYLOAD_CHUNK_BYTES = 64 * 1024;

export interface JsonlSessionRepositoryOptions {
	rootDir: string;
	replicaId: ReplicaId;
	modeGeneration: ModeGeneration;
	sourceNamespace?: string;
	installationNamespace?: string;
}

interface BranchState {
	source: SourceIdentity;
	sourceAlias: SourceAlias;
	fileName: string;
	physicalHeader: SessionHeader;
	header: RepositorySessionHeader;
	entries: readonly SessionEntry[];
	events: readonly RepositoryEvent[];
	eventsByHash: Map<EventHash, RepositoryEvent>;
}

interface ManifestBranch {
	fileName: string;
	source: SourceIdentity;
	sourceAlias: SourceAlias;
	originId: OriginId;
	branchId: BranchId;
	versionId: VersionId;
	parentVersionId: VersionId | null;
	forkPointHash: EventHash | null;
	metadata: SessionSemanticMetadata;
}
interface ManifestTombstone {
	branchId: BranchId;
	fileName: string;
	deletedAt: string;
}


interface RepositoryManifest {
	version: 1;
	modeGeneration: ModeGeneration;
	branches: ManifestBranch[];
	checkpoints: ContextCheckpoint[];
	payloads: PayloadDescriptor[];
	logicalLocations: [BranchId, string][];
	drafts: SessionDraft[];
	relatedResources: [string, SessionLocator][];
	terminalPointers: TerminalSessionPointer[];
	pinnedBranchIds: BranchId[];
	tombstones: ManifestTombstone[];
}

interface CursorEnvelope {
	kind: "list" | "search" | "tree" | "events" | "related" | "export";
	filter: string;
	modifiedAt?: string;
	branchId?: BranchId;
	generation?: number;
	eventHash?: EventHash;
	relationKey?: string;
}

export class StaleModeGenerationError extends Error {
	readonly expected: ModeGeneration;
	readonly actual: ModeGeneration;

	constructor(expected: ModeGeneration, actual: ModeGeneration) {
		super(`Stale storage mode generation: expected ${expected}, active ${actual}`);
		this.name = "StaleModeGenerationError";
		this.expected = expected;
		this.actual = actual;
	}
}

export class RepositoryIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RepositoryIntegrityError";
	}
}

function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_SIZE;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Page limit must be a positive integer");
	return Math.min(limit, MAX_PAGE_SIZE);
}

function lexicalCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function semanticMetadataFromHeader(header: SessionHeader): SessionSemanticMetadata {
	const metadata: SessionSemanticMetadata = {
		createdAt: header.timestamp,
	};
	if (header.title !== undefined) metadata.title = header.title;
	if (header.titleSource !== undefined) metadata.titleSource = header.titleSource;
	if (header.cwd !== "") metadata.cwd = header.cwd;
	if (header.additionalDirectories !== undefined) {
		metadata.additionalDirectories = [...header.additionalDirectories];
	}
	if (header.providerPromptCacheKey !== undefined) metadata.providerPromptCacheKey = header.providerPromptCacheKey;
	return metadata;
}

function eventSemanticPayload(entry: SessionEntry): Record<string, unknown> {
	const { id: _id, parentId: _parentId, ...payload } = entry;
	return payload;
}

function modifiedAt(metadata: SessionSemanticMetadata, entries: readonly SessionEntry[]): string {
	return entries.at(-1)?.timestamp ?? metadata.createdAt;
}

function fileNameForBranch(branchId: BranchId): string {
	return `${Buffer.from(branchId).toString("base64url")}.jsonl`;
}

function physicalHeaderForBranch(header: SessionHeader, branchId: BranchId): SessionHeader {
	return {
		...header,
		id: `repository-${branchId.slice(-32)}`,
		additionalDirectories: header.additionalDirectories ? [...header.additionalDirectories] : undefined,
		previousSessionFiles: undefined,
	};
}

function physicalHeaderWithMetadata(header: SessionHeader, metadata: SessionSemanticMetadata): SessionHeader {
	const updated = {
		...header,
		additionalDirectories: header.additionalDirectories ? [...header.additionalDirectories] : undefined,
	};
	if (metadata.title === undefined) delete updated.title;
	else updated.title = metadata.title;
	if (metadata.titleSource === undefined) delete updated.titleSource;
	else updated.titleSource = metadata.titleSource;
	return updated;
}

function serializeJsonl(header: SessionHeader, entries: readonly SessionEntry[]): string {
	let output = `${JSON.stringify(header)}\n`;
	for (const entry of entries) output += `${JSON.stringify(entry)}\n`;
	return output;
}

function encodeCursor(cursor: CursorEnvelope): KeysetCursor {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url") as KeysetCursor;
}

function decodeCursor(
	cursor: KeysetCursor | undefined,
	kind: CursorEnvelope["kind"],
	filter: string,
): CursorEnvelope | undefined {
	if (!cursor) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new RepositoryIntegrityError("Invalid repository keyset cursor");
	}
	if (typeof parsed !== "object" || parsed === null) throw new RepositoryIntegrityError("Invalid repository keyset cursor");
	const envelope = parsed as CursorEnvelope;
	if (envelope.kind !== kind || envelope.filter !== filter) {
		throw new RepositoryIntegrityError("Repository cursor does not belong to this query");
	}
	return envelope;
}

function cursorIndexAfter<T>(
	items: readonly T[],
	cursor: CursorEnvelope | undefined,
	matches: (item: T, cursor: CursorEnvelope) => boolean,
): number {
	if (!cursor) return 0;
	const index = items.findIndex(item => matches(item, cursor));
	if (index < 0) throw new RepositoryIntegrityError("Repository cursor no longer exists");
	return index + 1;
}

function emptyTransferReport(): TransferReport {
	return { imported: 0, extended: 0, forked: 0, duplicates: 0, quarantined: 0, deleted: 0 };
}

function isAncestor(state: BranchState, possibleAncestor: EventHash | null, descendant: EventHash | null): boolean {
	if (possibleAncestor === null) return true;
	let cursor = descendant;
	while (cursor !== null) {
		if (cursor === possibleAncestor) return true;
		cursor = state.eventsByHash.get(cursor)?.parentEventHash ?? null;
	}
	return false;
}
function relatedResourceKey(locator: RelatedResourceLocator): string {
	return JSON.stringify([locator.owner.branchId, locator.owner.versionId ?? null, locator.kind, locator.key]);
}
function relatedResourceLocatorFromKey(value: string): RelatedResourceLocator {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.length !== 4) {
		throw new RepositoryIntegrityError("Invalid related resource key");
	}
	const [branchId, versionId, kind, key] = parsed;
	if (
		typeof branchId !== "string" ||
		(versionId !== null && typeof versionId !== "string") ||
		(kind !== "artifact" && kind !== "child-session" && kind !== "advisor-session") ||
		typeof key !== "string"
	) {
		throw new RepositoryIntegrityError("Invalid related resource key");
	}
	return {
		owner: {
			branchId: branchId as BranchId,
			versionId: versionId === null ? undefined : (versionId as VersionId),
		},
		kind,
		key,
	};
}



/**
 * JSONL implementation of both the runtime repository and the explicitly
 * injected transfer service. This module has no Turso import (static or dynamic),
 * and construction performs no filesystem access.
 */
export class JsonlSessionRepository implements SessionRepository, SessionTransferService {
	readonly mode = "jsonl" as const;
	readonly replicaId: ReplicaId;
	readonly #rootDir: string;
	readonly #defaultSourceNamespace: string;
	readonly #defaultInstallationNamespace: string;
	readonly #collisions = new IdentityCollisionRegistry();
	readonly #branches = new Map<BranchId, BranchState>();
	readonly #checkpoints = new Map<string, ContextCheckpoint>();
	readonly #payloads = new Map<PayloadHash, PayloadDescriptor>();
	readonly #logicalLocations = new Map<BranchId, string>();
	readonly #drafts = new Map<BranchId, SessionDraft>();
	readonly #relatedResources = new Map<string, SessionLocator>();
	readonly #terminalPointers = new Map<string, TerminalSessionPointer>();
	readonly #pinnedBranchIds = new Set<BranchId>();
	readonly #healthDetails: string[] = [];
	#modeGeneration: ModeGeneration;
	#orphanManifestBranches: ManifestBranch[] = [];
	#tombstones: ManifestTombstone[] = [];
	#loadPromise: Promise<void> | undefined;
	#closed = false;

	constructor(options: JsonlSessionRepositoryOptions) {
		this.#rootDir = path.resolve(options.rootDir);
		this.replicaId = options.replicaId;
		this.#modeGeneration = options.modeGeneration;
		this.#defaultSourceNamespace = options.sourceNamespace ?? "omp";
		this.#defaultInstallationNamespace = options.installationNamespace ?? options.replicaId;
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

	async #ensureLoaded(): Promise<void> {
		if (this.#closed) throw new Error("Repository is closed");
		if (!this.#loadPromise) this.#loadPromise = this.#load();
		await this.#loadPromise;
	}

	async #load(): Promise<void> {
		if (!fs.existsSync(this.#rootDir)) return;
		const manifest = this.#readManifestSync();
		const claimedFiles = new Set<string>();
		if (manifest) {
			this.#modeGeneration = manifest.modeGeneration;
			for (const checkpoint of manifest.checkpoints) this.#checkpoints.set(checkpoint.checkpointId, checkpoint);
			for (const payload of manifest.payloads) this.#payloads.set(payload.payloadHash, payload);
			for (const [branchId, location] of manifest.logicalLocations) this.#logicalLocations.set(branchId, location);
			for (const draft of manifest.drafts) this.#drafts.set(draft.branchId, draft);
			for (const [key, locator] of manifest.relatedResources) this.#relatedResources.set(key, locator);
			for (const pointer of manifest.terminalPointers) this.#terminalPointers.set(pointer.terminalId, pointer);
			for (const branchId of manifest.pinnedBranchIds) this.#pinnedBranchIds.add(branchId);
			this.#tombstones = manifest.tombstones;
			for (const tombstone of manifest.tombstones) claimedFiles.add(tombstone.fileName);
			for (const branch of manifest.branches) {
				claimedFiles.add(branch.fileName);
				const filePath = path.join(this.#rootDir, branch.fileName);
				if (!fs.existsSync(filePath)) {
					this.#orphanManifestBranches.push(branch);
					this.#healthDetails.push(`Manifest branch file is missing: ${branch.fileName}`);
					continue;
				}
				try {
					const parsed = parseSessionContent(await Bun.file(filePath).text());
					const physicalHeader = parsed.entries[0];
					if (physicalHeader?.type !== "session") throw new RepositoryIntegrityError("Missing session header");
					const entries = parsed.entries.slice(1) as SessionEntry[];
					const state = this.#buildState({
						source: branch.source,
						sourceAlias: branch.sourceAlias,
						originId: branch.originId,
						branchId: branch.branchId,
						versionId: branch.versionId,
						parentVersionId: branch.parentVersionId,
						forkPointHash: branch.forkPointHash,
						header: physicalHeader,
						entries,
						metadata: branch.metadata,
					}, branch.fileName);
					this.#branches.set(state.header.branchId, state);
				} catch (error) {
					this.#orphanManifestBranches.push(branch);
					this.#healthDetails.push(`Failed to load ${branch.fileName}: ${String(error)}`);
				}
			}
		}

		for (const dirent of fs.readdirSync(this.#rootDir, { withFileTypes: true })) {
			if (!dirent.isFile() || !dirent.name.endsWith(".jsonl") || claimedFiles.has(dirent.name)) continue;
			try {
				const filePath = path.join(this.#rootDir, dirent.name);
				const parsed = parseSessionContent(await Bun.file(filePath).text());
				const physicalHeader = parsed.entries[0];
				if (physicalHeader?.type !== "session") throw new RepositoryIntegrityError("Missing session header");
				const source: SourceIdentity = {
					sourceNamespace: this.#defaultSourceNamespace,
					installationNamespace: this.#defaultInstallationNamespace,
					nativeId: physicalHeader.id,
				};
				const origin = computeOriginIdentity(source);
				const alias = computeSourceAlias(source);
				const branch = computeBranchIdentity({
					originId: origin.id,
					replicaId: this.replicaId,
					branchKey: `native:${alias.id}`,
				});
				const state = this.#buildState(
					{
						source,
						sourceAlias: alias.id,
						originId: origin.id,
						branchId: branch.id,
						versionId: "" as VersionId,
						parentVersionId: null,
						forkPointHash: null,
						header: physicalHeader,
						entries: parsed.entries.slice(1) as SessionEntry[],
						metadata: semanticMetadataFromHeader(physicalHeader),
					},
					dirent.name,
					false,
				);
				if (!this.#branches.has(state.header.branchId)) this.#branches.set(state.header.branchId, state);
			} catch (error) {
				this.#healthDetails.push(`Failed to discover ${dirent.name}: ${String(error)}`);
			}
		}
	}

	#buildState(item: SessionArchiveItem, fileName: string, verifyVersion = true): BranchState {
		const origin = computeOriginIdentity(item.source);
		const alias = computeSourceAlias(item.source);
		this.#collisions.remember(origin);
		this.#collisions.remember(alias);
		assertIdentityClaim(item.originId, origin);
		assertIdentityClaim(item.sourceAlias, alias);

		const entriesById = new Map<string, SessionEntry>();
		for (const entry of item.entries) {
			if (entriesById.has(entry.id)) throw new RepositoryIntegrityError(`Duplicate native entry id: ${entry.id}`);
			entriesById.set(entry.id, entry);
		}
		const eventsByNativeId = new Map<string, RepositoryEvent>();
		const visiting = new Set<string>();
		const resolveEvent = (entry: SessionEntry): RepositoryEvent => {
			const existing = eventsByNativeId.get(entry.id);
			if (existing) return existing;
			if (visiting.has(entry.id)) throw new RepositoryIntegrityError(`Cyclic event ancestry at ${entry.id}`);
			visiting.add(entry.id);
			try {
				const parent = entry.parentId === null ? undefined : entriesById.get(entry.parentId);
				if (entry.parentId !== null && !parent) {
					throw new RepositoryIntegrityError(`Missing parent ${entry.parentId} for entry ${entry.id}`);
				}
				const parentEvent = parent ? resolveEvent(parent) : undefined;
				const identity = computeEventIdentity({
					originId: origin.id,
					nativeEntryId: entry.id,
					parentEventHash: parentEvent?.eventHash ?? null,
					semanticPayload: eventSemanticPayload(entry),
				});
				this.#collisions.remember(identity);
				const event: RepositoryEvent = {
					eventHash: identity.id,
					originId: origin.id,
					parentEventHash: parentEvent?.eventHash ?? null,
					nativeEntryId: entry.id,
					generation: (parentEvent?.generation ?? -1) + 1,
					entry,
				};
				eventsByNativeId.set(entry.id, event);
				return event;
			} finally {
				visiting.delete(entry.id);
			}
		};
		const events = item.entries.map(resolveEvent);
		const selectedEntryId = item.metadata.extensions?.selectedEntryId;
		const headEvent =
			typeof selectedEntryId === "string" ? eventsByNativeId.get(selectedEntryId) : events.at(-1);
		if (selectedEntryId !== undefined && !headEvent) {
			throw new RepositoryIntegrityError(`Selected entry does not exist: ${String(selectedEntryId)}`);
		}
		const eventsByHash = new Map(events.map(event => [event.eventHash, event]));
		const version = computeVersionIdentity({
			originId: origin.id,
			headEventHash: headEvent?.eventHash ?? null,
			treeEventHashes: events.map(event => event.eventHash),
			metadata: item.metadata,
		});
		this.#collisions.remember(version);
		if (verifyVersion) assertIdentityClaim(item.versionId, version);

		return {
			source: item.source,
			sourceAlias: alias.id,
			fileName,
			physicalHeader: {
				...item.header,
				additionalDirectories: item.header.additionalDirectories
					? [...item.header.additionalDirectories]
					: undefined,
			},
			header: {
				originId: origin.id,
				branchId: item.branchId,
				versionId: version.id,
				sourceAlias: alias.id,
				replicaId: this.replicaId,
				headEventHash: headEvent?.eventHash ?? null,
				forkPointHash: item.forkPointHash,
				parentVersionId: item.parentVersionId,
				generation: headEvent?.generation ?? 0,
				metadata: item.metadata,
				modifiedAt: modifiedAt(item.metadata, item.entries),
			},
			entries: item.entries,
			events,
			eventsByHash,
		};
	}

	#readManifestSync(): RepositoryManifest | undefined {
		const manifestPath = path.join(this.#rootDir, MANIFEST_NAME);
		if (!fs.existsSync(manifestPath)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RepositoryManifest;
		if (parsed.version !== 1 || typeof parsed.modeGeneration !== "string") {
			throw new RepositoryIntegrityError("Unsupported JSONL repository manifest");
		}
		return {
			version: 1,
			modeGeneration: parsed.modeGeneration,
			branches: Array.isArray(parsed.branches) ? parsed.branches : [],
			checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
			payloads: Array.isArray(parsed.payloads) ? parsed.payloads : [],
			logicalLocations: Array.isArray(parsed.logicalLocations) ? parsed.logicalLocations : [],
			drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
			relatedResources: Array.isArray(parsed.relatedResources) ? parsed.relatedResources : [],
			terminalPointers: Array.isArray(parsed.terminalPointers) ? parsed.terminalPointers : [],
			pinnedBranchIds: Array.isArray(parsed.pinnedBranchIds) ? parsed.pinnedBranchIds : [],
			tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
		};
	}

	#assertFenceSync(expected: ModeGeneration): void {
		const persisted = this.#readManifestSync()?.modeGeneration ?? this.#modeGeneration;
		if (expected !== persisted) throw new StaleModeGenerationError(expected, persisted);
		this.#modeGeneration = persisted;
	}

	#manifest(): RepositoryManifest {
		const branches: ManifestBranch[] = [...this.#branches.values()].map(state => ({
			fileName: state.fileName,
			source: state.source,
			sourceAlias: state.sourceAlias,
			originId: state.header.originId,
			branchId: state.header.branchId,
			versionId: state.header.versionId,
			parentVersionId: state.header.parentVersionId,
			forkPointHash: state.header.forkPointHash,
			metadata: state.header.metadata,
		}));
		branches.push(...this.#orphanManifestBranches);
		return {
			version: 1,
			modeGeneration: this.#modeGeneration,
			branches,
			checkpoints: [...this.#checkpoints.values()],
			payloads: [...this.#payloads.values()],
			logicalLocations: [...this.#logicalLocations.entries()],
			drafts: [...this.#drafts.values()],
			relatedResources: [...this.#relatedResources.entries()],
			terminalPointers: [...this.#terminalPointers.values()],
			pinnedBranchIds: [...this.#pinnedBranchIds],
			tombstones: [...this.#tombstones],
		};
	}

	#writeManifestSync(): void {
		fs.mkdirSync(this.#rootDir, { recursive: true });
		const destination = path.join(this.#rootDir, MANIFEST_NAME);
		const temporary = `${destination}.${Bun.randomUUIDv7()}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(this.#manifest())}\n`);
		fs.renameSync(temporary, destination);
	}

	#publishStateSync(state: BranchState, expectedModeGeneration: ModeGeneration): void {
		this.#assertFenceSync(expectedModeGeneration);
		fs.mkdirSync(this.#rootDir, { recursive: true });
		const destination = path.join(this.#rootDir, state.fileName);
		const temporary = `${destination}.${Bun.randomUUIDv7()}.tmp`;
		fs.writeFileSync(temporary, serializeJsonl(state.physicalHeader, state.entries));
		fs.renameSync(temporary, destination);
		const prior = this.#branches.get(state.header.branchId);
		this.#branches.set(state.header.branchId, state);
		try {
			this.#writeManifestSync();
		} catch (error) {
			if (prior) this.#branches.set(prior.header.branchId, prior);
			else this.#branches.delete(state.header.branchId);
			throw error;
		}
	}

	#archiveItem(state: BranchState): SessionExportItem {
		return {
			source: state.source,
			sourceAlias: state.sourceAlias,
			originId: state.header.originId,
			branchId: state.header.branchId,
			versionId: state.header.versionId,
			parentVersionId: state.header.parentVersionId,
			forkPointHash: state.header.forkPointHash,
			header: state.physicalHeader,
			entries: state.entries,
			metadata: state.header.metadata,
		};
	}

	#ancestryEntries(state: BranchState, head: EventHash | null): SessionEntry[] {
		const reversed: SessionEntry[] = [];
		let cursor = head;
		while (cursor !== null) {
			const event = state.eventsByHash.get(cursor);
			if (!event) throw new RepositoryIntegrityError(`Unknown event ${cursor}`);
			reversed.push(event.entry);
			cursor = event.parentEventHash;
		}
		return reversed.reverse();
	}

	async listSessions(query: ListSessionsQuery = {}): Promise<KeysetPage<RepositorySessionHeader>> {
		await this.#ensureLoaded();
		const filter = JSON.stringify({ originId: query.originId ?? null, sourceAlias: query.sourceAlias ?? null });
		const cursor = decodeCursor(query.cursor, "list", filter);
		const headers = [...this.#branches.values()]
			.map(state => state.header)
			.filter(header => !query.originId || header.originId === query.originId)
			.filter(header => !query.sourceAlias || header.sourceAlias === query.sourceAlias)
			.sort((left, right) => {
				const byTime = lexicalCompare(right.modifiedAt, left.modifiedAt);
				return byTime !== 0 ? byTime : lexicalCompare(left.branchId, right.branchId);
			});
		const after = cursorIndexAfter(
			headers,
			cursor,
			(header, keyset) => header.modifiedAt === keyset.modifiedAt && header.branchId === keyset.branchId,
		);
		const limit = boundedLimit(query.limit);
		const items = headers.slice(after, after + limit);
		const last = items.at(-1);
		return {
			items,
			nextCursor:
				last && after + items.length < headers.length
					? encodeCursor({ kind: "list", filter, modifiedAt: last.modifiedAt, branchId: last.branchId })
					: undefined,
		};
	}

	async search(query: SearchSessionsQuery): Promise<KeysetPage<SessionSearchHit>> {
		await this.#ensureLoaded();
		const needle = query.text.toLocaleLowerCase();
		const filter = JSON.stringify({ text: query.text, originId: query.originId ?? null });
		const cursor = decodeCursor(query.cursor, "search", filter);
		const hits: SessionSearchHit[] = [];
		for (const state of this.#branches.values()) {
			if (query.originId && state.header.originId !== query.originId) continue;
			const title = state.header.metadata.title ?? "";
			let snippet = title;
			let eventHash: EventHash | undefined;
			if (!title.toLocaleLowerCase().includes(needle)) {
				const event = state.events.find(candidate => JSON.stringify(candidate.entry).toLocaleLowerCase().includes(needle));
				if (!event) continue;
				eventHash = event.eventHash;
				snippet = JSON.stringify(event.entry).slice(0, 240);
			}
			hits.push({ header: state.header, eventHash, snippet });
		}
		hits.sort((left, right) => {
			const byTime = lexicalCompare(right.header.modifiedAt, left.header.modifiedAt);
			return byTime !== 0 ? byTime : lexicalCompare(left.header.branchId, right.header.branchId);
		});
		const after = cursorIndexAfter(
			hits,
			cursor,
			(hit, keyset) => hit.header.modifiedAt === keyset.modifiedAt && hit.header.branchId === keyset.branchId,
		);
		const limit = boundedLimit(query.limit);
		const items = hits.slice(after, after + limit);
		const last = items.at(-1);
		return {
			items,
			nextCursor:
				last && after + items.length < hits.length
					? encodeCursor({
							kind: "search",
							filter,
							modifiedAt: last.header.modifiedAt,
							branchId: last.header.branchId,
						})
					: undefined,
		};
	}

	async readTree(query: ReadTreeQuery): Promise<KeysetPage<RepositoryTreeNode>> {
		await this.#ensureLoaded();
		const state = this.#branches.get(query.branchId);
		if (!state) return { items: [] };
		const filter = query.branchId;
		const cursor = decodeCursor(query.cursor, "tree", filter);
		const children = new Map<EventHash | null, EventHash[]>();
		for (const event of state.events) {
			const bucket = children.get(event.parentEventHash) ?? [];
			bucket.push(event.eventHash);
			children.set(event.parentEventHash, bucket);
		}
		const nodes: RepositoryTreeNode[] = state.events
			.map(event => ({ ...event, childEventHashes: children.get(event.eventHash) ?? [] }))
			.sort((left, right) => left.generation - right.generation || lexicalCompare(left.eventHash, right.eventHash));
		const after = cursorIndexAfter(
			nodes,
			cursor,
			(node, keyset) => node.generation === keyset.generation && node.eventHash === keyset.eventHash,
		);
		const limit = boundedLimit(query.limit);
		const items = nodes.slice(after, after + limit);
		const last = items.at(-1);
		return {
			items,
			nextCursor:
				last && after + items.length < nodes.length
					? encodeCursor({
							kind: "tree",
							filter,
							generation: last.generation,
							eventHash: last.eventHash,
						})
					: undefined,
		};
	}

	async getHeader(request: GetHeaderRequest): Promise<RepositorySessionHeader | undefined> {
		await this.#ensureLoaded();
		return this.#branches.get(request.branchId)?.header;
	}
	async readEvents(query: ReadEventsQuery): Promise<KeysetPage<RepositoryEvent>> {
		await this.#ensureLoaded();
		const state = this.#branches.get(query.branchId);
		if (!state || (query.versionId && query.versionId !== state.header.versionId)) return { items: [] };
		const filter = JSON.stringify({ branchId: query.branchId, versionId: query.versionId ?? null });
		const cursor = decodeCursor(query.cursor, "events", filter);
		const events = [...state.events].sort(
			(left, right) => left.generation - right.generation || lexicalCompare(left.eventHash, right.eventHash),
		);
		let after = 0;
		if (cursor) {
			const cursorIndex = events.findIndex(
				event => event.generation === cursor.generation && event.eventHash === cursor.eventHash,
			);
			if (cursorIndex < 0) throw new RepositoryIntegrityError("Event cursor no longer exists");
			after = cursorIndex + 1;
		}
		const limit = boundedLimit(query.limit);
		const items = events.slice(after, after + limit);
		const last = items.at(-1);
		return {
			items,
			nextCursor:
				last && after + items.length < events.length
					? encodeCursor({
							kind: "events",
							filter,
							generation: last.generation,
							eventHash: last.eventHash,
						})
					: undefined,
		};
	}


	async createSession(request: CreateSessionRequest): Promise<RepositorySessionHeader> {
		await this.#ensureLoaded();
		if (request.callerKey.length === 0) throw new TypeError("Session caller key must not be empty");
		if (request.header.type !== "session") throw new RepositoryIntegrityError("Session header type must be session");
		if (request.header.id !== request.source.nativeId) {
			throw new RepositoryIntegrityError("Session header id must match the source native id");
		}
		const origin = computeOriginIdentity(request.source);
		const alias = computeSourceAlias(request.source);
		const branch = computeBranchIdentity({
			originId: origin.id,
			replicaId: this.replicaId,
			branchKey: `create:${request.callerKey}`,
		});
		this.#collisions.remember(origin);
		this.#collisions.remember(alias);
		this.#collisions.remember(branch);
		const existing = this.#branches.get(branch.id);
		if (existing) {
			if (existing.header.originId !== origin.id || existing.header.sourceAlias !== alias.id) {
				throw new RepositoryIntegrityError("Stable session caller key resolved to conflicting identity");
			}
			this.#assertFenceSync(request.expectedModeGeneration);
			return existing.header;
		}
		const metadata = request.metadata ?? semanticMetadataFromHeader(request.header);
		const state = this.#buildState(
			{
				source: request.source,
				sourceAlias: alias.id,
				originId: origin.id,
				branchId: branch.id,
				versionId: "" as VersionId,
				parentVersionId: null,
				forkPointHash: null,
				header: physicalHeaderWithMetadata(request.header, metadata),
				entries: [],
				metadata,
			},
			fileNameForBranch(branch.id),
			false,
		);
		this.#publishStateSync(state, request.expectedModeGeneration);
		return state.header;
	}

	async appendWithExpectedHead(request: AppendWithExpectedHeadRequest): Promise<AppendWithExpectedHeadResult> {
		await this.#ensureLoaded();
		const current = this.#branches.get(request.branchId);
		if (!current) throw new RepositoryIntegrityError(`Unknown branch ${request.branchId}`);
		if (request.entries.length === 0 && !request.metadata) {
			this.#assertFenceSync(request.expectedModeGeneration);
			return { status: "idempotent", header: current.header };
		}
		if (request.expectedHeadHash !== null && !current.eventsByHash.has(request.expectedHeadHash)) {
			throw new RepositoryIntegrityError(`Expected head is not in branch ancestry: ${request.expectedHeadHash}`);
		}

		const lostCas = current.header.headEventHash !== request.expectedHeadHash;
		const baseEntries = lostCas
			? this.#ancestryEntries(current, request.expectedHeadHash)
			: [...current.entries];
		const combinedEntries = [...baseEntries, ...request.entries];
		const metadata = request.metadata ?? current.header.metadata;
		const provisionalBranchId = current.header.branchId;
		const provisional = this.#buildState(
			{
				...this.#archiveItem(current),
				branchId: provisionalBranchId,
				versionId: "" as VersionId,
				parentVersionId: current.header.versionId,
				forkPointHash: lostCas ? request.expectedHeadHash : current.header.forkPointHash,
				entries: combinedEntries,
				metadata,
				header: physicalHeaderWithMetadata(current.physicalHeader, metadata),
			},
			current.fileName,
			false,
		);

		if (!lostCas) {
			if (provisional.header.versionId === current.header.versionId) {
				this.#assertFenceSync(request.expectedModeGeneration);
				return { status: "idempotent", header: current.header };
			}
			this.#publishStateSync(provisional, request.expectedModeGeneration);
			return { status: "appended", header: provisional.header };
		}

		const sibling = computeBranchIdentity({
			originId: current.header.originId,
			replicaId: this.replicaId,
			branchKey: `cas:${current.header.branchId}:${request.expectedHeadHash ?? "root"}:${provisional.header.versionId}`,
		});
		this.#collisions.remember(sibling);
		const existingSibling = this.#branches.get(sibling.id);
		if (existingSibling) {
			this.#assertFenceSync(request.expectedModeGeneration);
			return {
				status: "forked",
				header: existingSibling.header,
				conflictedBranchId: current.header.branchId,
			};
		}
		const siblingState = this.#buildState(
			{
				...this.#archiveItem(provisional),
				branchId: sibling.id,
				header: physicalHeaderForBranch(provisional.physicalHeader, sibling.id),
			},
			fileNameForBranch(sibling.id),
		);
		this.#publishStateSync(siblingState, request.expectedModeGeneration);
		return { status: "forked", header: siblingState.header, conflictedBranchId: current.header.branchId };
	}

	async fork(request: ForkRequest): Promise<RepositorySessionHeader> {
		await this.#ensureLoaded();
		const current = this.#branches.get(request.branchId);
		if (!current) throw new RepositoryIntegrityError(`Unknown branch ${request.branchId}`);
		if (request.atEventHash !== null && !current.eventsByHash.has(request.atEventHash)) {
			throw new RepositoryIntegrityError(`Fork point is not in branch ancestry: ${request.atEventHash}`);
		}
		const branch = computeBranchIdentity({
			originId: current.header.originId,
			replicaId: this.replicaId,
			branchKey: `fork:${current.header.branchId}:${request.atEventHash ?? "root"}:${request.forkKey}`,
		});
		this.#collisions.remember(branch);
		const existing = this.#branches.get(branch.id);
		if (existing) {
			this.#assertFenceSync(request.expectedModeGeneration);
			return existing.header;
		}
		const entries = this.#ancestryEntries(current, request.atEventHash);
		const state = this.#buildState(
			{
				...this.#archiveItem(current),
				branchId: branch.id,
				versionId: "" as VersionId,
				parentVersionId: current.header.parentVersionId,
				forkPointHash: request.atEventHash,
				header: physicalHeaderForBranch(current.physicalHeader, branch.id),
				entries,
				metadata: request.metadata ?? current.header.metadata,
			},
			fileNameForBranch(branch.id),
			false,
		);
		this.#publishStateSync(state, request.expectedModeGeneration);
		return state.header;
	}
	async updateTitle(request: UpdateSessionTitleRequest): Promise<RepositorySessionHeader> {
		await this.#ensureLoaded();
		const current = this.#branches.get(request.branchId);
		if (!current) throw new RepositoryIntegrityError(`Unknown branch ${request.branchId}`);
		const metadata: SessionSemanticMetadata = {
			...current.header.metadata,
			extensions: {
				...current.header.metadata.extensions,
				titleUpdatedAt: request.updatedAt,
			},
		};
		if (request.title === undefined) delete metadata.title;
		else metadata.title = request.title;
		if (request.source === undefined) delete metadata.titleSource;
		else metadata.titleSource = request.source;
		const result = await this.appendWithExpectedHead({
			branchId: request.branchId,
			expectedHeadHash: request.expectedHeadHash,
			expectedModeGeneration: request.expectedModeGeneration,
			entries: [],
			metadata,
		});
		return result.header;
	}

	async drop(request: DropSessionRequest): Promise<boolean> {
		await this.#ensureLoaded();
		const current = this.#branches.get(request.locator.branchId);
		if (!current) return false;
		if (request.locator.versionId && request.locator.versionId !== current.header.versionId) {
			throw new RepositoryIntegrityError("Drop locator version is stale");
		}
		this.#assertFenceSync(request.expectedModeGeneration);
		this.#branches.delete(current.header.branchId);
		this.#drafts.delete(current.header.branchId);
		this.#logicalLocations.delete(current.header.branchId);
		this.#pinnedBranchIds.delete(current.header.branchId);
		const tombstone: ManifestTombstone = {
			branchId: current.header.branchId,
			fileName: current.fileName,
			deletedAt: new Date().toISOString(),
		};
		this.#tombstones.push(tombstone);
		try {
			this.#writeManifestSync();
		} catch (error) {
			this.#tombstones.pop();
			this.#branches.set(current.header.branchId, current);
			throw error;
		}
		const filePath = path.join(this.#rootDir, current.fileName);
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		return true;
	}

	async relocate(request: RelocateSessionRequest): Promise<SessionLocator> {
		await this.#ensureLoaded();
		if (request.logicalLocation.length === 0) throw new TypeError("Logical location must not be empty");
		const current = this.#branches.get(request.locator.branchId);
		if (!current) throw new RepositoryIntegrityError(`Unknown branch ${request.locator.branchId}`);
		if (request.locator.versionId && request.locator.versionId !== current.header.versionId) {
			throw new RepositoryIntegrityError("Relocation locator version is stale");
		}
		this.#assertFenceSync(request.expectedModeGeneration);
		this.#logicalLocations.set(current.header.branchId, request.logicalLocation);
		this.#writeManifestSync();
		return { branchId: current.header.branchId, versionId: current.header.versionId };
	}

	async saveDraft(request: SaveDraftRequest): Promise<SessionDraft> {
		await this.#ensureLoaded();
		if (!this.#branches.has(request.draft.branchId)) {
			throw new RepositoryIntegrityError(`Unknown branch ${request.draft.branchId}`);
		}
		if (!this.#payloads.has(request.draft.payloadHash)) {
			throw new RepositoryIntegrityError(`Unknown draft payload ${request.draft.payloadHash}`);
		}
		const prior = this.#drafts.get(request.draft.branchId);
		if ((prior?.revision ?? null) !== request.expectedRevision) {
			throw new RepositoryIntegrityError("Draft revision compare-and-swap failed");
		}
		this.#assertFenceSync(request.expectedModeGeneration);
		this.#drafts.set(request.draft.branchId, request.draft);
		this.#writeManifestSync();
		return request.draft;
	}

	async consumeDraft(request: ConsumeDraftRequest): Promise<SessionDraft | undefined> {
		await this.#ensureLoaded();
		const draft = this.#drafts.get(request.branchId);
		if (!draft) return undefined;
		if (draft.revision !== request.expectedRevision) {
			throw new RepositoryIntegrityError("Draft revision compare-and-swap failed");
		}
		this.#assertFenceSync(request.expectedModeGeneration);
		this.#drafts.delete(request.branchId);
		this.#writeManifestSync();
		return draft;
	}

	async registerRelatedResource(request: RegisterRelatedResourceRequest): Promise<void> {
		await this.#ensureLoaded();
		if (!this.#branches.has(request.locator.owner.branchId) || !this.#branches.has(request.target.branchId)) {
			throw new RepositoryIntegrityError("Related resource locator references an unknown branch");
		}
		this.#assertFenceSync(request.expectedModeGeneration);
		this.#relatedResources.set(relatedResourceKey(request.locator), request.target);
		this.#writeManifestSync();
	}

	async resolveRelatedResource(locator: RelatedResourceLocator): Promise<SessionLocator | undefined> {
		await this.#ensureLoaded();
		return this.#relatedResources.get(relatedResourceKey(locator));
	}
	async listRelatedResources(query: ListRelatedResourcesQuery): Promise<KeysetPage<RelatedResourceBinding>> {
		await this.#ensureLoaded();
		const filter = JSON.stringify({
			ownerBranchId: query.owner.branchId,
			ownerVersionId: query.owner.versionId ?? null,
			kind: query.kind ?? null,
		});
		const cursor = decodeCursor(query.cursor, "related", filter);
		const bindings = [...this.#relatedResources.entries()]
			.map(([key, target]) => ({ key, locator: relatedResourceLocatorFromKey(key), target }))
			.filter(binding => binding.locator.owner.branchId === query.owner.branchId)
			.filter(binding => !query.owner.versionId || binding.locator.owner.versionId === query.owner.versionId)
			.filter(binding => !query.kind || binding.locator.kind === query.kind)
			.sort((left, right) => lexicalCompare(left.key, right.key));
		const after = cursorIndexAfter(bindings, cursor, (binding, keyset) => binding.key === keyset.relationKey);
		const limit = boundedLimit(query.limit);
		const page = bindings.slice(after, after + limit);
		const last = page.at(-1);
		return {
			items: page.map(({ locator, target }) => ({ locator, target })),
			nextCursor:
				last && after + page.length < bindings.length
					? encodeCursor({ kind: "related", filter, relationKey: last.key })
					: undefined,
		};
	}


	async setTerminalSessionPointer(request: SetTerminalSessionPointerRequest): Promise<void> {
		await this.#ensureLoaded();
		if (!this.#branches.has(request.pointer.session.branchId)) {
			throw new RepositoryIntegrityError(`Unknown branch ${request.pointer.session.branchId}`);
		}
		this.#assertFenceSync(request.expectedModeGeneration);
		this.#terminalPointers.set(request.pointer.terminalId, request.pointer);
		this.#writeManifestSync();
	}

	async getTerminalSessionPointer(terminalId: string): Promise<TerminalSessionPointer | undefined> {
		await this.#ensureLoaded();
		return this.#terminalPointers.get(terminalId);
	}

	async setPinned(request: SetSessionPinnedRequest): Promise<void> {
		await this.#ensureLoaded();
		if (!this.#branches.has(request.branchId)) throw new RepositoryIntegrityError(`Unknown branch ${request.branchId}`);
		this.#assertFenceSync(request.expectedModeGeneration);
		if (request.pinned) this.#pinnedBranchIds.add(request.branchId);
		else this.#pinnedBranchIds.delete(request.branchId);
		this.#writeManifestSync();
	}

	async listPinned(): Promise<readonly BranchId[]> {
		await this.#ensureLoaded();
		return [...this.#pinnedBranchIds];
	}


	async putCheckpoint(request: WriteCheckpointRequest): Promise<void> {
		await this.#ensureLoaded();
		const state = this.#branches.get(request.checkpoint.branchId);
		if (!state) throw new RepositoryIntegrityError(`Unknown branch ${request.checkpoint.branchId}`);
		if (state.header.headEventHash !== request.checkpoint.headEventHash) {
			throw new RepositoryIntegrityError("Checkpoint head is not the current branch head");
		}
		this.#assertFenceSync(request.expectedModeGeneration);
		const prior = this.#checkpoints.get(request.checkpoint.checkpointId);
		this.#checkpoints.set(request.checkpoint.checkpointId, request.checkpoint);
		try {
			this.#writeManifestSync();
		} catch (error) {
			if (prior) this.#checkpoints.set(prior.checkpointId, prior);
			else this.#checkpoints.delete(request.checkpoint.checkpointId);
			throw error;
		}
	}

	async *readContextTail(request: ReadContextTailRequest): AsyncIterable<RepositoryEvent> {
		await this.#ensureLoaded();
		if (!Number.isSafeInteger(request.maxEntries) || request.maxEntries < 0) {
			throw new RangeError("maxEntries must be a non-negative integer");
		}
		const state = this.#branches.get(request.branchId);
		if (!state) return;
		if (request.checkpoint && request.checkpoint.branchId !== request.branchId) {
			throw new RepositoryIntegrityError("Checkpoint belongs to another branch");
		}
		const ancestry = this.#ancestryEntries(state, state.header.headEventHash);
		const nativeStart = request.checkpoint?.headEventHash
			? state.eventsByHash.get(request.checkpoint.headEventHash)?.nativeEntryId
			: undefined;
		const startIndex = nativeStart ? ancestry.findIndex(entry => entry.id === nativeStart) + 1 : 0;
		let emitted = 0;
		for (const entry of ancestry.slice(Math.max(startIndex, 0))) {
			if (emitted >= request.maxEntries) return;
			const event = state.events.find(candidate => candidate.nativeEntryId === entry.id);
			if (event) {
				yield event;
				emitted++;
			}
		}
	}

	async writePayload(request: WritePayloadRequest): Promise<PayloadDescriptor> {
		await this.#ensureLoaded();
		const directory = path.join(this.#rootDir, PAYLOAD_DIRECTORY);
		fs.mkdirSync(directory, { recursive: true });
		const temporary = path.join(directory, `.${Bun.randomUUIDv7()}.tmp`);
		const file = await fs.promises.open(temporary, "wx");
		const hasher = new Bun.CryptoHasher("sha256");
		let byteLength = 0;
		try {
			for await (const chunk of request.bytes) {
				if (!(chunk instanceof Uint8Array)) throw new TypeError("Payload chunks must be Uint8Array values");
				await file.write(chunk);
				hasher.update(chunk);
				byteLength += chunk.byteLength;
			}
		} finally {
			await file.close();
		}
		const payloadHash = `payload_v1_${hasher.digest("hex")}` as PayloadHash;
		const destination = path.join(directory, payloadHash);
		if (fs.existsSync(destination)) fs.unlinkSync(temporary);
		else fs.renameSync(temporary, destination);
		const descriptor: PayloadDescriptor = { payloadHash, byteLength, mediaType: request.mediaType };
		this.#payloads.set(payloadHash, descriptor);
		this.#writeManifestSync();
		return descriptor;
	}

	async *readPayload(request: ReadPayloadRequest): AsyncIterable<Uint8Array> {
		await this.#ensureLoaded();
		const chunkBytes = request.chunkBytes ?? DEFAULT_PAYLOAD_CHUNK_BYTES;
		if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new RangeError("chunkBytes must be positive");
		const file = Bun.file(path.join(this.#rootDir, PAYLOAD_DIRECTORY, request.payloadHash));
		if (!(await file.exists())) throw new RepositoryIntegrityError(`Unknown payload ${request.payloadHash}`);
		for (let offset = 0; offset < file.size; offset += chunkBytes) {
			yield new Uint8Array(await file.slice(offset, Math.min(offset + chunkBytes, file.size)).arrayBuffer());
		}
	}

	async importArchive(
		items: AsyncIterable<SessionImportItem> | Iterable<SessionImportItem>,
		options: ImportArchiveOptions,
	): Promise<TransferReport> {
		await this.#ensureLoaded();
		this.#assertFenceSync(options.expectedModeGeneration);
		const report = emptyTransferReport();
		for await (const item of items) {
			try {
				const incoming = this.#buildState(item, fileNameForBranch(item.branchId));
				const existing = this.#branches.get(item.branchId);
				if (existing?.header.versionId === incoming.header.versionId) {
					report.duplicates++;
					continue;
				}
				if (!existing) {
					this.#publishStateSync(incoming, options.expectedModeGeneration);
					report.imported++;
					continue;
				}
				if (
					existing.header.originId === incoming.header.originId &&
					isAncestor(incoming, existing.header.headEventHash, incoming.header.headEventHash) &&
					existing.events.every(event => incoming.eventsByHash.has(event.eventHash))
				) {
					const extension = this.#buildState(
						{
							...this.#archiveItem(incoming),
							branchId: existing.header.branchId,
							parentVersionId: existing.header.versionId,
						},
						existing.fileName,
					);
					this.#publishStateSync(extension, options.expectedModeGeneration);
					report.extended++;
					continue;
				}

				const sibling = computeBranchIdentity({
					originId: incoming.header.originId,
					replicaId: this.replicaId,
					branchKey: `sync:${options.sourceReplicaId ?? "unknown"}:${item.branchId}:${item.versionId}`,
				});
				this.#collisions.remember(sibling);
				const priorSibling = this.#branches.get(sibling.id);
				if (priorSibling?.header.versionId === incoming.header.versionId) {
					report.duplicates++;
					continue;
				}
				const forkPointHash = incoming.events
					.filter(event => existing.eventsByHash.has(event.eventHash))
					.sort((left, right) => right.generation - left.generation)[0]?.eventHash ?? null;
				const siblingState = this.#buildState(
					{
						...this.#archiveItem(incoming),
						branchId: sibling.id,
						parentVersionId: existing.header.versionId,
						forkPointHash,
						header: physicalHeaderForBranch(incoming.physicalHeader, sibling.id),
					},
					fileNameForBranch(sibling.id),
				);
				this.#publishStateSync(siblingState, options.expectedModeGeneration);
				report.forked++;
			} catch (error) {
				if (error instanceof StaleModeGenerationError) throw error;
				report.quarantined++;
			}
		}
		return report;
	}

	async *exportArchive(query: ExportArchiveQuery = {}): AsyncIterable<SessionExportItem> {
		await this.#ensureLoaded();
		const filter = JSON.stringify({ originId: query.originId ?? null, branchId: query.branchId ?? null });
		const cursor = decodeCursor(query.cursor, "export", filter);
		const states = [...this.#branches.values()]
			.filter(state => !query.originId || state.header.originId === query.originId)
			.filter(state => !query.branchId || state.header.branchId === query.branchId)
			.sort((left, right) => lexicalCompare(left.header.branchId, right.header.branchId));
		const after = cursorIndexAfter(
			states,
			cursor,
			(state, keyset) => state.header.branchId === keyset.branchId,
		);
		const limit = query.limit === undefined ? states.length : boundedLimit(query.limit);
		for (const state of states.slice(after, after + limit)) yield this.#archiveItem(state);
	}

	async syncFrom(source: SessionTransferService, options: SyncOptions): Promise<TransferReport> {
		return this.importArchive(source.exportArchive({ originId: options.originId }), options);
	}

	async flush(request: FlushRequest): Promise<void> {
		await this.#ensureLoaded();
		this.#assertFenceSync(request.expectedModeGeneration);
		this.#writeManifestSync();
	}

	async health(): Promise<RepositoryHealth> {
		await this.#ensureLoaded();
		const persisted = this.#readManifestSync()?.modeGeneration ?? this.#modeGeneration;
		this.#modeGeneration = persisted;
		return {
			mode: "jsonl",
			status: this.#healthDetails.length > 0 ? "degraded" : "ok",
			replicaId: this.replicaId,
			modeGeneration: persisted,
			writable: !this.#closed,
			details: this.#healthDetails.length > 0 ? [...this.#healthDetails] : undefined,
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		if (this.#loadPromise) await this.#loadPromise;
		this.#closed = true;
	}
}
