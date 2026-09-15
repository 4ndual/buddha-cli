import * as fs from "node:fs/promises";
import * as path from "node:path";
import { replaceFileAtomically } from "../utils/atomic-file";
import type {
	ArchiveStreamLimits,
	BranchId,
	KeysetCursor,
	ModeGeneration,
	OriginId,
	PayloadHash,
	RelatedResourceKind,
	RelatedResourceLocator,
	RepositoryEvent,
	SessionArchiveItem,
	SessionLocator,
	SessionRepository,
	SessionTransferService,
} from "./repository/types";
import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionHeader, type SessionMessageEntry } from "./session-entries";

/** Default page size for transcript consumers. Every repository read remains bounded. */
export const REPOSITORY_TRANSCRIPT_PAGE_SIZE = 200;
/** Hard safety ceiling for consumers that deliberately materialize one transcript. */
export const MAX_MATERIALIZED_TRANSCRIPT_ENTRIES = 200_000;
/** Hard bounds for one explicitly materialized JSONL-compatible archive item. */
export const REPOSITORY_ARCHIVE_LIMITS: ArchiveStreamLimits = {
	maxEntryBytes: 16 * 1024 * 1024,
	maxEntriesPerPage: REPOSITORY_TRANSCRIPT_PAGE_SIZE,
	maxTotalEntries: MAX_MATERIALIZED_TRANSCRIPT_ENTRIES,
	maxTotalEntryBytes: 16 * 1024 * 1024 * 1024,
	maxPayloadRefsPerPage: REPOSITORY_TRANSCRIPT_PAGE_SIZE,
	maxTotalPayloadRefs: MAX_MATERIALIZED_TRANSCRIPT_ENTRIES,
};

export interface RepositorySessionSource {
	repository: SessionRepository;
	locator: SessionLocator;
}

export interface ExplicitRepositoryExportSource extends RepositorySessionSource {
	transferService: SessionTransferService;
}

export interface RepositoryTranscriptPage {
	entries: readonly SessionEntry[];
	events: readonly RepositoryEvent[];
	nextCursor?: KeysetCursor;
}

function boundedPageSize(limit: number | undefined): number {
	if (limit === undefined) return REPOSITORY_TRANSCRIPT_PAGE_SIZE;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Transcript page limit must be a positive integer");
	return Math.min(limit, REPOSITORY_TRANSCRIPT_PAGE_SIZE);
}

/** Read one keyset page. Callers retain the opaque cursor rather than byte offsets. */
export async function readRepositoryTranscriptPage(
	source: RepositorySessionSource,
	options: { cursor?: KeysetCursor; limit?: number } = {},
): Promise<RepositoryTranscriptPage> {
	const page = await source.repository.readEvents({
		...source.locator,
		cursor: options.cursor,
		limit: boundedPageSize(options.limit),
	});
	return { events: page.items, entries: page.items.map(event => event.entry), nextCursor: page.nextCursor };
}

/**
 * Materialize a deliberately bounded transcript for render/history/export consumers.
 * Runtime resume uses readContextTail instead and must not call this helper.
 */
export async function readRepositoryTranscript(
	source: RepositorySessionSource,
	options: { maxEntries?: number; shouldContinue?: () => boolean } = {},
): Promise<SessionEntry[]> {
	const maxEntries = options.maxEntries ?? MAX_MATERIALIZED_TRANSCRIPT_ENTRIES;
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
	const entries: SessionEntry[] = [];
	let cursor: KeysetCursor | undefined;
	do {
		if (options.shouldContinue?.() === false) break;
		const remaining = maxEntries - entries.length;
		if (remaining <= 0) throw new Error(`Transcript exceeds the ${maxEntries}-entry materialization limit`);
		const page = await readRepositoryTranscriptPage(source, { cursor, limit: Math.min(remaining, REPOSITORY_TRANSCRIPT_PAGE_SIZE) });
		entries.push(...page.entries);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return entries;
}

export async function readRepositoryMessages(
	source: RepositorySessionSource,
	options: { maxEntries?: number; shouldContinue?: () => boolean } = {},
): Promise<SessionMessageEntry["message"][]> {
	const entries = await readRepositoryTranscript(source, options);
	return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message").map(entry => entry.message);
}

/** Resolve one named relation without path/stem inference. */
export async function resolveRepositoryResource(
	source: RepositorySessionSource,
	kind: RelatedResourceKind,
	key: string,
): Promise<RepositorySessionSource | undefined> {
	const locator = await source.repository.resolveRelatedResource({ owner: source.locator, kind, key });
	return locator ? { repository: source.repository, locator } : undefined;
}
/** Publish a logical child/advisor relation with the repository's current mode fence. */
export async function registerRepositoryRelatedSession(
	source: RepositorySessionSource,
	kind: RelatedResourceKind,
	key: string,
	target: SessionLocator,
): Promise<void> {
	const { modeGeneration } = await source.repository.health();
	await source.repository.registerRelatedResource({
		expectedModeGeneration: modeGeneration,
		locator: { owner: source.locator, kind, key },
		target,
	});
}


/** Read one exact branch snapshot through the explicit transfer boundary. */
export async function exportRepositorySessionItem(source: ExplicitRepositoryExportSource): Promise<SessionArchiveItem> {
	const header = await source.repository.getHeader({ branchId: source.locator.branchId });
	if (!header) throw new Error(`Unknown repository branch: ${source.locator.branchId}`);
	const expectedVersion = source.locator.versionId ?? header.versionId;
	for await (const item of source.transferService.exportArchive({
		branchId: source.locator.branchId,
		limit: 1,
		limits: REPOSITORY_ARCHIVE_LIMITS,
	})) {
		if (item.versionId !== expectedVersion) {
			throw new Error(`Export returned version ${item.versionId} instead of ${expectedVersion}`);
		}
		return item;
	}
	throw new Error(`Repository export returned no item for branch ${source.locator.branchId}`);
}
/** Materialize the bounded entry pages exposed by an archive item. */
export async function readRepositoryArchiveEntries(item: SessionArchiveItem): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = [];
	let entryBytes = 0;
	for await (const page of item.openEntryPages()) {
		if (page.items.length < 1 || page.items.length > REPOSITORY_ARCHIVE_LIMITS.maxEntriesPerPage) {
			throw new Error("Repository archive emitted an invalid entry page");
		}
		let pageBytes = 0;
		for (const record of page.items) {
			const actualBytes = Buffer.byteLength(JSON.stringify(record.entry));
			if (actualBytes !== record.encodedByteLength || actualBytes > REPOSITORY_ARCHIVE_LIMITS.maxEntryBytes) {
				throw new Error(`Repository archive entry ${record.entry.id} has invalid byte accounting`);
			}
			entries.push(record.entry);
			pageBytes += actualBytes;
			entryBytes += actualBytes;
			if (
				entries.length > REPOSITORY_ARCHIVE_LIMITS.maxTotalEntries ||
				entryBytes > REPOSITORY_ARCHIVE_LIMITS.maxTotalEntryBytes
			) {
				throw new Error("Repository archive exceeded materialization limits");
			}
		}
		if (pageBytes !== page.byteLength) throw new Error("Repository archive page has invalid byte accounting");
	}
	if (entries.length !== item.entryCount || entryBytes !== item.entryBytes) {
		throw new Error("Repository archive stream does not match its declared entry totals");
	}
	return entries;
}

/**
 * Explicit DB → JSONL transfer. This is the only helper in this module that creates
 * a session JSONL file; ordinary repository reads never receive a destination path.
 */
export async function exportRepositorySessionToJsonl(
	source: ExplicitRepositoryExportSource,
	outputPath: string,
): Promise<string> {
	const item = await exportRepositorySessionItem(source);
	const destination = path.resolve(outputPath);
	const tempPath = `${destination}.tmp-${crypto.randomUUID()}`;
	let entryCount = 0;
	let entryBytes = 0;
	try {
		const handle = await fs.open(tempPath, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(item.header)}\n`);
			for await (const page of item.openEntryPages()) {
				if (page.items.length < 1 || page.items.length > REPOSITORY_ARCHIVE_LIMITS.maxEntriesPerPage) {
					throw new Error("Repository archive emitted an invalid entry page");
				}
				let pageBytes = 0;
				for (const record of page.items) {
					const serialized = JSON.stringify(record.entry);
					const actualBytes = Buffer.byteLength(serialized);
					if (actualBytes !== record.encodedByteLength || actualBytes > REPOSITORY_ARCHIVE_LIMITS.maxEntryBytes) {
						throw new Error(`Repository archive entry ${record.entry.id} has invalid byte accounting`);
					}
					entryCount++;
					entryBytes += actualBytes;
					pageBytes += actualBytes;
					if (
						entryCount > REPOSITORY_ARCHIVE_LIMITS.maxTotalEntries ||
						entryBytes > REPOSITORY_ARCHIVE_LIMITS.maxTotalEntryBytes
					) {
						throw new Error("Repository archive exceeded streaming limits");
					}
					await handle.writeFile(`${serialized}\n`);
				}
				if (pageBytes !== page.byteLength) throw new Error("Repository archive page has invalid byte accounting");
			}
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (entryCount !== item.entryCount || entryBytes !== item.entryBytes) {
			throw new Error("Repository archive stream does not match its declared entry totals");
		}
		await replaceFileAtomically(tempPath, destination);
		const parent = await fs.open(path.dirname(destination), "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
	return destination;
}

export interface RepositorySessionSnapshot {
	header: SessionHeader;
	entries: readonly SessionEntry[];
	originId: OriginId;
	locator: Required<SessionLocator>;
}

/** Export snapshot for HTML/share/debug renderers. Requires explicit transfer injection. */
export async function readRepositoryExportSnapshot(
	source: ExplicitRepositoryExportSource,
): Promise<RepositorySessionSnapshot> {
	const item = await exportRepositorySessionItem(source);
	const entries = await readRepositoryArchiveEntries(item);
	return {
		header: item.header,
		entries,
		originId: item.originId,
		locator: { branchId: item.branchId, versionId: item.versionId },
	};
}

const ARTIFACT_METADATA_KEY = "omp.related-artifact.v1";

export interface RepositoryArtifact {
	locator: RelatedResourceLocator;
	target: SessionLocator;
	payloadHash: PayloadHash;
	mediaType?: string;
}

/** Repository-native artifact allocator. No artifact path exists in DB mode. */
export class RepositoryArtifactManager {
	#nextId = 0;
	#initialized = false;

	constructor(
		readonly repository: SessionRepository,
		readonly owner: SessionLocator,
		readonly modeGeneration: ModeGeneration,
	) {}

	async #listBindings(): Promise<Array<{ locator: RelatedResourceLocator; target: SessionLocator }>> {
		const bindings: Array<{ locator: RelatedResourceLocator; target: SessionLocator }> = [];
		let cursor: KeysetCursor | undefined;
		do {
			const page = await this.repository.listRelatedResources({
				owner: this.owner,
				kind: "artifact",
				cursor,
				limit: REPOSITORY_TRANSCRIPT_PAGE_SIZE,
			});
			bindings.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return bindings;
	}

	async #ensureInitialized(): Promise<void> {
		if (this.#initialized) return;
		let max = -1;
		for (const binding of await this.#listBindings()) {
			if (/^\d+$/.test(binding.locator.key)) max = Math.max(max, Number(binding.locator.key));
		}
		this.#nextId = max + 1;
		this.#initialized = true;
	}

	async save(content: string, toolType: string): Promise<string> {
		await this.#ensureInitialized();
		return this.saveNamed(String(this.#nextId++), content, toolType);
	}

	async saveNamed(id: string, content: string, toolType: string): Promise<string> {
		if (!id || id.includes("/") || id.includes("\\")) throw new Error(`Invalid artifact id: ${id}`);
		const existing = await this.repository.resolveRelatedResource({ owner: this.owner, kind: "artifact", key: id });
		if (existing) throw new Error(`Artifact ${id} already exists`);
		const mediaType = `text/plain; charset=utf-8; tool=${encodeURIComponent(toolType)}`;
		const bytes = Buffer.from(content);
		const descriptor = await this.repository.writePayload({
			bytes: [bytes],
			maxBytes: bytes.byteLength,
			maxChunkBytes: Math.max(1, bytes.byteLength),
			expectedModeGeneration: this.modeGeneration,
			mediaType,
		});
		const now = new Date().toISOString();
		const nativeId = `artifact:${this.owner.branchId}:${id}`;
		const artifactHeader = await this.repository.createSession({
			expectedModeGeneration: this.modeGeneration,
			source: {
				sourceNamespace: "omp-artifact",
				installationNamespace: this.repository.replicaId,
				nativeId,
			},
			header: {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: nativeId,
				timestamp: now,
				cwd: "",
			},
			metadata: {
				createdAt: now,
				extensions: {
					[ARTIFACT_METADATA_KEY]: {
						payloadHash: descriptor.payloadHash,
						mediaType,
					},
				},
			},
			callerKey: `artifact:${this.owner.branchId}:${this.owner.versionId ?? ""}:${id}`,
		});
		const target = { branchId: artifactHeader.branchId, versionId: artifactHeader.versionId };
		await this.repository.registerRelatedResource({
			expectedModeGeneration: this.modeGeneration,
			locator: { owner: this.owner, kind: "artifact", key: id },
			target,
		});
		return id;
	}

	async resolve(id: string): Promise<RepositoryArtifact | undefined> {
		const target = await this.repository.resolveRelatedResource({ owner: this.owner, kind: "artifact", key: id });
		if (!target) return undefined;
		const header = await this.repository.getHeader({ branchId: target.branchId });
		const metadata = header?.metadata.extensions?.[ARTIFACT_METADATA_KEY];
		if (typeof metadata !== "object" || metadata === null) return undefined;
		const record = metadata as Record<string, unknown>;
		if (typeof record.payloadHash !== "string") return undefined;
		return {
			locator: { owner: this.owner, kind: "artifact", key: id },
			target,
			payloadHash: record.payloadHash as PayloadHash,
			...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
		};
	}

	async read(id: string): Promise<Uint8Array | undefined> {
		const artifact = await this.resolve(id);
		if (!artifact) return undefined;
		const chunks: Uint8Array[] = [];
		let length = 0;
		for await (const chunk of this.repository.readPayload({ payloadHash: artifact.payloadHash })) {
			chunks.push(chunk);
			length += chunk.byteLength;
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}
}

/** Narrow helper for call sites that already obtained repository health. */
export function repositoryGeneration(health: { modeGeneration: ModeGeneration }): ModeGeneration {
	return health.modeGeneration;
}

export function branchOf(source: RepositorySessionSource): BranchId {
	return source.locator.branchId;
}
