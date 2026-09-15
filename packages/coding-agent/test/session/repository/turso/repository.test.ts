import { describe, expect, it } from "bun:test";
import { createSessionRepository } from "../../../../src/session/repository/provider";
import {
	TursoSessionRepository,
	type TursoAppendMutation,
	type TursoCreateMutation,
	type TursoDurableFlushReceipt,
	type TursoForkMutation,
	type TursoKeysetRow,
	type TursoRuntimeAdapter,
	type TursoRuntimeHealth,
	type TursoRuntimeTransaction,
} from "../../../../src/session/repository/turso/repository";
import { computeReplicaIdentity, modeGeneration } from "../../../../src/session/repository/identity";
import type { KeysetPosition } from "../../../../src/session/repository/turso/pagination";
import type { SessionEntry } from "../../../../src/session/session-entries";
import type {
	BranchId,
	CheckpointId,
	ConsumeDraftRequest,
	CreateSessionRequest,
	DropSessionRequest,
	EventHash,
	ListRelatedResourcesQuery,
	ListSessionsQuery,
	ModeGeneration,
	OriginId,
	PayloadDescriptor,
	PayloadHash,
	ReadEventsQuery,
	ReadTreeQuery,
	RegisterRelatedResourceRequest,
	RelatedResourceBinding,
	RelatedResourceLocator,
	RelocateSessionRequest,
	RepositoryEvent,
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
	SourceAlias,
	TerminalSessionPointer,
	UpdateSessionTitleRequest,
	VersionId,
	WriteCheckpointRequest,
	WritePayloadRequest,
} from "../../../../src/session/repository";

const GENERATION = modeGeneration("db-mode-generation-7");
const REPLICA_ID = computeReplicaIdentity("runtime-adapter-test").id;
const NOW = "2026-09-15T00:00:00.000Z";

class FakeRuntimeAdapter implements TursoRuntimeAdapter, TursoRuntimeTransaction {
	readonly replicaId = REPLICA_ID;
	readonly headers = new Map<BranchId, RepositorySessionHeader>();
	readonly events = new Map<BranchId, RepositoryEvent[]>();
	readonly payloads = new Map<PayloadHash, Uint8Array>();
	readonly drafts = new Map<BranchId, SessionDraft>();
	readonly related = new Map<string, RelatedResourceBinding>();
	readonly terminals = new Map<string, TerminalSessionPointer>();
	readonly pinned = new Set<BranchId>();
	readonly checkpoints = new Map<CheckpointId, WriteCheckpointRequest["checkpoint"]>();
	readonly logicalLocations = new Map<BranchId, string>();
	requestedLimits: number[] = [];
	flushes = 0;
	closed = false;
	modeGeneration: ModeGeneration = GENERATION;
	returnTooManyRows = false;
	oversizePayloadChunk = false;
	overrunContextTail = false;
	#version = 0;

	async transaction<T>(work: (transaction: TursoRuntimeTransaction) => Promise<T>): Promise<T> {
		return work(this);
	}

	async assertModeGeneration(expected: ModeGeneration): Promise<void> {
		if (expected !== this.modeGeneration) throw new Error("stale mode generation");
	}

	async getHeader(branchId: BranchId): Promise<RepositorySessionHeader | undefined> {
		return this.headers.get(branchId);
	}

	async isEventReachable(branchId: BranchId, eventHash: EventHash | null): Promise<boolean> {
		if (eventHash === null) return this.headers.has(branchId);
		return (this.events.get(branchId) ?? []).some(event => event.eventHash === eventHash);
	}

	async createSession(mutation: TursoCreateMutation): Promise<RepositorySessionHeader> {
		const existing = this.headers.get(mutation.targetBranchId);
		if (existing) return existing;
		const metadata = mutation.request.metadata ?? {
			createdAt: mutation.request.header.timestamp,
			cwd: mutation.request.header.cwd,
			title: mutation.request.header.title,
			titleSource: mutation.request.header.titleSource,
		};
		const header: RepositorySessionHeader = {
			originId: mutation.originId,
			branchId: mutation.targetBranchId,
			versionId: this.#nextVersion(),
			sourceAlias: mutation.sourceAlias,
			replicaId: this.replicaId,
			headEventHash: null,
			forkPointHash: null,
			parentVersionId: null,
			generation: 0,
			metadata,
			modifiedAt: metadata.createdAt,
		};
		this.headers.set(header.branchId, header);
		this.events.set(header.branchId, []);
		return header;
	}

	async append(mutation: TursoAppendMutation): Promise<{ header: RepositorySessionHeader; changed: boolean }> {
		const source = this.headers.get(mutation.request.branchId);
		if (!source) throw new Error("unknown branch");
		const existingTarget = this.headers.get(mutation.targetBranchId);
		const sourceEvents = this.events.get(source.branchId) ?? [];
		const forkIndex =
			mutation.request.expectedHeadHash === null
				? -1
				: sourceEvents.findIndex(event => event.eventHash === mutation.request.expectedHeadHash);
		const baseEvents = mutation.parentBranchId ? sourceEvents.slice(0, forkIndex + 1) : sourceEvents;
		let parentEventHash = mutation.request.expectedHeadHash;
		let generation = baseEvents.at(-1)?.generation ?? -1;
		const appendedEvents = mutation.request.entries.map(entry => {
			generation++;
			const eventHash = `event:${entry.id}` as EventHash;
			const event: RepositoryEvent = {
				eventHash,
				originId: source.originId,
				parentEventHash,
				nativeEntryId: entry.id,
				generation,
				entry,
			};
			parentEventHash = eventHash;
			return event;
		});
		const metadata = mutation.request.metadata ?? source.metadata;
		const nextEvents = [...baseEvents, ...appendedEvents];
		const changed =
			appendedEvents.length > 0 || JSON.stringify(metadata) !== JSON.stringify((existingTarget ?? source).metadata);
		if (existingTarget && !changed) return { header: existingTarget, changed: false };
		const header: RepositorySessionHeader = {
			...source,
			branchId: mutation.targetBranchId,
			versionId: changed ? this.#nextVersion() : source.versionId,
			headEventHash: parentEventHash,
			forkPointHash: mutation.forkPointHash,
			parentVersionId: source.versionId,
			generation: Math.max(0, generation),
			metadata,
			modifiedAt: appendedEvents.at(-1)?.entry.timestamp ?? metadata.createdAt,
		};
		this.headers.set(header.branchId, header);
		this.events.set(header.branchId, nextEvents);
		return { header, changed };
	}

	async fork(mutation: TursoForkMutation): Promise<RepositorySessionHeader> {
		const existing = this.headers.get(mutation.targetBranchId);
		if (existing) return existing;
		const source = this.headers.get(mutation.request.branchId);
		if (!source) throw new Error("unknown branch");
		const sourceEvents = this.events.get(source.branchId) ?? [];
		const index =
			mutation.request.atEventHash === null
				? -1
				: sourceEvents.findIndex(event => event.eventHash === mutation.request.atEventHash);
		const selected = sourceEvents.slice(0, index + 1);
		const metadata = mutation.request.metadata ?? source.metadata;
		const header: RepositorySessionHeader = {
			...source,
			branchId: mutation.targetBranchId,
			versionId: this.#nextVersion(),
			headEventHash: mutation.request.atEventHash,
			forkPointHash: mutation.request.atEventHash,
			parentVersionId: source.versionId,
			generation: selected.at(-1)?.generation ?? 0,
			metadata,
		};
		this.headers.set(header.branchId, header);
		this.events.set(header.branchId, selected);
		return header;
	}

	async updateTitle(request: UpdateSessionTitleRequest): Promise<RepositorySessionHeader> {
		const current = this.headers.get(request.branchId);
		if (!current) throw new Error("unknown branch");
		const lostCas = current.headEventHash !== request.expectedHeadHash;
		const branchId = lostCas ? (`title:${request.branchId}:${request.expectedHeadHash ?? "root"}` as BranchId) : request.branchId;
		const sourceEvents = this.events.get(request.branchId) ?? [];
		const expectedIndex =
			request.expectedHeadHash === null
				? -1
				: sourceEvents.findIndex(event => event.eventHash === request.expectedHeadHash);
		const metadata = {
			...current.metadata,
			title: request.title,
			titleSource: request.source,
			extensions: { ...current.metadata.extensions, titleUpdatedAt: request.updatedAt },
		};
		const header: RepositorySessionHeader = {
			...current,
			branchId,
			versionId: this.#nextVersion(),
			forkPointHash: lostCas ? request.expectedHeadHash : current.forkPointHash,
			parentVersionId: current.versionId,
			metadata,
		};
		this.headers.set(branchId, header);
		if (lostCas) this.events.set(branchId, sourceEvents.slice(0, expectedIndex + 1));
		return header;
	}

	async drop(request: DropSessionRequest): Promise<boolean> {
		const header = this.headers.get(request.locator.branchId);
		if (!header) return false;
		if (request.locator.versionId && request.locator.versionId !== header.versionId) throw new Error("stale locator");
		this.headers.delete(header.branchId);
		this.events.delete(header.branchId);
		return true;
	}

	async relocate(request: RelocateSessionRequest): Promise<SessionLocator> {
		const header = this.headers.get(request.locator.branchId);
		if (!header) throw new Error("unknown branch");
		this.logicalLocations.set(header.branchId, request.logicalLocation);
		return { branchId: header.branchId, versionId: header.versionId };
	}

	async saveDraft(request: SaveDraftRequest): Promise<SessionDraft> {
		const current = this.drafts.get(request.draft.branchId);
		if ((current?.revision ?? null) !== request.expectedRevision) throw new Error("draft CAS failed");
		this.drafts.set(request.draft.branchId, request.draft);
		return request.draft;
	}

	async consumeDraft(request: ConsumeDraftRequest): Promise<SessionDraft | undefined> {
		const current = this.drafts.get(request.branchId);
		if (!current) return undefined;
		if (current.revision !== request.expectedRevision) throw new Error("draft CAS failed");
		this.drafts.delete(request.branchId);
		return current;
	}

	async registerRelatedResource(request: RegisterRelatedResourceRequest): Promise<void> {
		this.related.set(this.#relatedKey(request.locator), { locator: request.locator, target: request.target });
	}

	async setTerminalSessionPointer(request: SetTerminalSessionPointerRequest): Promise<void> {
		this.terminals.set(request.pointer.terminalId, request.pointer);
	}

	async setPinned(request: SetSessionPinnedRequest): Promise<void> {
		if (request.pinned) this.pinned.add(request.branchId);
		else this.pinned.delete(request.branchId);
	}

	async putCheckpoint(request: WriteCheckpointRequest): Promise<void> {
		this.checkpoints.set(request.checkpoint.checkpointId, request.checkpoint);
	}

	async listSessions(query: {
		after?: KeysetPosition;
		limit: number;
		originId?: OriginId;
		sourceAlias?: SourceAlias;
	}): Promise<readonly TursoKeysetRow<RepositorySessionHeader>[]> {
		this.requestedLimits.push(query.limit);
		const rows = [...this.headers.values()]
			.filter(header => !query.originId || header.originId === query.originId)
			.filter(header => !query.sourceAlias || header.sourceAlias === query.sourceAlias)
			.sort((left, right) => left.branchId.localeCompare(right.branchId))
			.map(header => this.#row(header, header.modifiedAt, header.branchId));
		const selected = this.#after(rows, query.after).slice(0, query.limit + (this.returnTooManyRows ? 1 : 0));
		return selected;
	}

	async search(query: {
		after?: KeysetPosition;
		limit: number;
		text: string;
		originId?: OriginId;
	}): Promise<readonly TursoKeysetRow<SessionSearchHit>[]> {
		const needle = query.text.toLocaleLowerCase();
		const rows = [...this.headers.values()]
			.filter(header => !query.originId || header.originId === query.originId)
			.filter(header => (header.metadata.title ?? "").toLocaleLowerCase().includes(needle))
			.map(header =>
				this.#row<SessionSearchHit>({ header, snippet: header.metadata.title ?? "" }, header.modifiedAt, header.branchId),
			);
		return this.#after(rows, query.after).slice(0, query.limit);
	}

	async readTree(query: {
		after?: KeysetPosition;
		limit: number;
		branchId: BranchId;
	}): Promise<readonly TursoKeysetRow<RepositoryTreeNode>[]> {
		const events = this.events.get(query.branchId) ?? [];
		const rows = events.map(event => {
			const childEventHashes = events
				.filter(candidate => candidate.parentEventHash === event.eventHash)
				.map(candidate => candidate.eventHash);
			return this.#row<RepositoryTreeNode>(
				{ ...event, childEventHashes },
				String(event.generation).padStart(12, "0"),
				event.eventHash,
			);
		});
		return this.#after(rows, query.after).slice(0, query.limit);
	}

	async readEvents(query: {
		after?: KeysetPosition;
		limit: number;
		branchId: BranchId;
		versionId?: VersionId;
	}): Promise<readonly TursoKeysetRow<RepositoryEvent>[]> {
		const header = this.headers.get(query.branchId);
		if (!header || (query.versionId && query.versionId !== header.versionId)) return [];
		const rows = (this.events.get(query.branchId) ?? []).map(event =>
			this.#row(event, String(event.generation).padStart(12, "0"), event.eventHash),
		);
		return this.#after(rows, query.after).slice(0, query.limit);
	}

	async listRelatedResources(query: {
		after?: KeysetPosition;
		limit: number;
		owner: SessionLocator;
		kind?: ListRelatedResourcesQuery["kind"];
	}): Promise<readonly TursoKeysetRow<RelatedResourceBinding>[]> {
		const rows = [...this.related.entries()]
			.filter(([, binding]) => binding.locator.owner.branchId === query.owner.branchId)
			.filter(([, binding]) => !query.owner.versionId || binding.locator.owner.versionId === query.owner.versionId)
			.filter(([, binding]) => !query.kind || binding.locator.kind === query.kind)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, binding]) => this.#row(binding, key, key));
		return this.#after(rows, query.after).slice(0, query.limit);
	}

	async *readContextTail(query: {
		branchId: BranchId;
		afterEventHash?: EventHash;
		limit: number;
	}): AsyncIterable<RepositoryEvent> {
		const events = this.events.get(query.branchId) ?? [];
		const index = query.afterEventHash ? events.findIndex(event => event.eventHash === query.afterEventHash) + 1 : 0;
		const count = query.limit + (this.overrunContextTail ? 1 : 0);
		for (const event of events.slice(index, index + count)) yield event;
	}

	async writePayload(request: WritePayloadRequest): Promise<PayloadDescriptor> {
		const chunks: Uint8Array[] = [];
		let length = 0;
		for await (const chunk of request.bytes) {
			chunks.push(chunk);
			length += chunk.byteLength;
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const payloadHash = `payload:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` as PayloadHash;
		this.payloads.set(payloadHash, bytes);
		return { payloadHash, byteLength: bytes.byteLength, mediaType: request.mediaType };
	}

	async *readPayload(query: { payloadHash: PayloadHash; chunkBytes: number }): AsyncIterable<Uint8Array> {
		const bytes = this.payloads.get(query.payloadHash);
		if (!bytes) throw new Error("unknown payload");
		const chunkBytes = this.oversizePayloadChunk ? query.chunkBytes + 1 : query.chunkBytes;
		for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
			yield bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkBytes));
		}
	}

	async resolveRelatedResource(locator: RelatedResourceLocator): Promise<SessionLocator | undefined> {
		return this.related.get(this.#relatedKey(locator))?.target;
	}

	async getTerminalSessionPointer(terminalId: string): Promise<TerminalSessionPointer | undefined> {
		return this.terminals.get(terminalId);
	}

	async listPinned(limit: number): Promise<readonly BranchId[]> {
		return [...this.pinned].slice(0, limit);
	}

	async flush(expectedModeGeneration: ModeGeneration): Promise<TursoDurableFlushReceipt> {
		await this.assertModeGeneration(expectedModeGeneration);
		this.flushes++;
		return {
			modeGeneration: this.modeGeneration,
			durable: true,
			committedSequence: String(this.flushes),
			checkpointed: true,
		};
	}

	async health(): Promise<TursoRuntimeHealth> {
		return { status: "ok", modeGeneration: this.modeGeneration, writable: !this.closed };
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	#nextVersion(): VersionId {
		this.#version++;
		return `version:${this.#version}` as VersionId;
	}

	#relatedKey(locator: RelatedResourceLocator): string {
		return JSON.stringify([locator.owner.branchId, locator.owner.versionId ?? null, locator.kind, locator.key]);
	}

	#row<T>(value: T, sortKey: string, id: string): TursoKeysetRow<T> {
		return { value, position: { sortKey, id } };
	}

	#after<T>(rows: readonly TursoKeysetRow<T>[], position: KeysetPosition | undefined): TursoKeysetRow<T>[] {
		if (!position) return [...rows];
		const index = rows.findIndex(row => row.position.sortKey === position.sortKey && row.position.id === position.id);
		return rows.slice(index + 1);
	}
}

function sessionRequest(callerKey: string, expectedModeGeneration = GENERATION): CreateSessionRequest {
	return {
		expectedModeGeneration,
		callerKey,
		source: { sourceNamespace: "omp", installationNamespace: "test", nativeId: callerKey },
		header: { type: "session", version: 3, id: callerKey, timestamp: NOW, cwd: "/logical/workspace", title: callerKey },
	};
}

function entry(id: string, parentId: string | null): SessionEntry {
	return { type: "custom", id, parentId, timestamp: NOW, customType: "test", data: { id } };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const collected: T[] = [];
	for await (const value of values) collected.push(value);
	return collected;
}

describe("TursoSessionRepository authoritative contract", () => {
	it("implements the complete logical repository interface through an injected adapter", async () => {
		const adapter = new FakeRuntimeAdapter();
		const repository = new TursoSessionRepository({ adapter, defaultPageSize: 2, maxPageSize: 4, payloadChunkBytes: 2 });
		const contract: SessionRepository = repository;
		const created = await contract.createSession(sessionRequest("native-session"));
		const appended = await contract.appendWithExpectedHead({
			branchId: created.branchId,
			expectedHeadHash: null,
			expectedModeGeneration: GENERATION,
			entries: [entry("a", null), entry("b", "a")],
		});
		expect(appended.status).toBe("appended");
		const header = appended.header;

		expect((await contract.getHeader({ branchId: created.branchId }))?.headEventHash).toBe("event:b" as EventHash);
		expect((await contract.readEvents({ branchId: created.branchId })).items.map(event => event.nativeEntryId)).toEqual([
			"a",
			"b",
		]);
		expect((await contract.readTree({ branchId: created.branchId })).items[0]?.childEventHashes).toEqual([
			"event:b" as EventHash,
		]);
		expect((await contract.listSessions()).items).toHaveLength(1);
		expect((await contract.search({ text: "native" })).items).toHaveLength(1);

		const renamed = await contract.updateTitle({
			branchId: created.branchId,
			expectedHeadHash: header.headEventHash,
			expectedModeGeneration: GENERATION,
			title: "Renamed",
			source: "user",
			updatedAt: NOW,
		});
		expect(renamed.metadata.title).toBe("Renamed");
		const forked = await contract.fork({
			branchId: created.branchId,
			atEventHash: "event:a" as EventHash,
			forkKey: "manual",
			expectedModeGeneration: GENERATION,
		});
		expect(forked.branchId).not.toBe(created.branchId);
		expect(
			await contract.relocate({
				locator: { branchId: created.branchId },
				logicalLocation: "profile:archive",
				expectedModeGeneration: GENERATION,
			}),
		).toMatchObject({ branchId: created.branchId });

		const payloadBytes = new Uint8Array([1, 2, 3, 4]);
		const payload = await contract.writePayload({
			bytes: [payloadBytes],
			maxBytes: payloadBytes.byteLength,
			maxChunkBytes: payloadBytes.byteLength,
			expectedModeGeneration: GENERATION,
			mediaType: "application/test",
		});
		expect((await collect(contract.readPayload({ payloadHash: payload.payloadHash, chunkBytes: 2 }))).map(chunk => chunk.length)).toEqual([
			2,
			2,
		]);
		const draft: SessionDraft = { branchId: created.branchId, revision: "1", payloadHash: payload.payloadHash, updatedAt: NOW };
		expect(await contract.saveDraft({ draft, expectedRevision: null, expectedModeGeneration: GENERATION })).toEqual(draft);
		expect(
			await contract.consumeDraft({
				branchId: created.branchId,
				expectedRevision: "1",
				expectedModeGeneration: GENERATION,
			}),
		).toEqual(draft);

		const locator: RelatedResourceLocator = {
			owner: { branchId: created.branchId },
			kind: "child-session",
			key: "child-1",
		};
		await contract.registerRelatedResource({ locator, target: { branchId: forked.branchId }, expectedModeGeneration: GENERATION });
		expect(await contract.resolveRelatedResource(locator)).toEqual({ branchId: forked.branchId });
		expect((await contract.listRelatedResources({ owner: locator.owner })).items).toHaveLength(1);

		const pointer: TerminalSessionPointer = { terminalId: "terminal-1", session: { branchId: created.branchId }, updatedAt: NOW };
		await contract.setTerminalSessionPointer({ pointer, expectedModeGeneration: GENERATION });
		expect(await contract.getTerminalSessionPointer("terminal-1")).toEqual(pointer);
		await contract.setPinned({ branchId: created.branchId, pinned: true, expectedModeGeneration: GENERATION });
		expect(await contract.listPinned()).toEqual([created.branchId]);

		await contract.putCheckpoint({
			expectedModeGeneration: GENERATION,
			checkpoint: {
				checkpointId: "checkpoint:1" as CheckpointId,
				branchId: created.branchId,
				headEventHash: "event:a" as EventHash,
				contextBuilderVersion: "1",
				contextHash: "context-hash",
				payloadHash: payload.payloadHash,
				createdAt: NOW,
			},
		});
		expect(
			(await collect(
				contract.readContextTail({
					branchId: created.branchId,
					checkpoint: adapter.checkpoints.get("checkpoint:1" as CheckpointId),
					maxEntries: 2,
				}),
			)).map(event => event.nativeEntryId),
		).toEqual(["b"]);
		await contract.flush({ expectedModeGeneration: GENERATION });
		expect(adapter.flushes).toBe(1);
		expect((await contract.health()).mode).toBe("db");
		expect(contract.capabilities().siblingForkOnConflict).toBe(true);
		expect(await contract.drop({ locator: { branchId: forked.branchId }, explicit: true, expectedModeGeneration: GENERATION })).toBe(
			true,
		);
		await contract.close();
		expect(adapter.closed).toBe(true);
	});

	it("preserves a losing expected-head append on a deterministic sibling", async () => {
		const adapter = new FakeRuntimeAdapter();
		const repository = new TursoSessionRepository({ adapter });
		const created = await repository.createSession(sessionRequest("cas-session"));
		const first = await repository.appendWithExpectedHead({
			branchId: created.branchId,
			expectedHeadHash: null,
			expectedModeGeneration: GENERATION,
			entries: [entry("base", null)],
		});
		await repository.appendWithExpectedHead({
			branchId: created.branchId,
			expectedHeadHash: first.header.headEventHash,
			expectedModeGeneration: GENERATION,
			entries: [entry("winner", "base")],
		});
		const loser = await repository.appendWithExpectedHead({
			branchId: created.branchId,
			expectedHeadHash: first.header.headEventHash,
			expectedModeGeneration: GENERATION,
			entries: [entry("loser", "base")],
		});
		expect(loser.status).toBe("forked");
		if (loser.status !== "forked") throw new Error("expected sibling fork");
		expect(loser.conflictedBranchId).toBe(created.branchId);
		expect(loser.header.branchId).not.toBe(created.branchId);
		expect((await repository.getHeader({ branchId: created.branchId }))?.headEventHash).toBe("event:winner" as EventHash);
		expect((await repository.getHeader({ branchId: loser.header.branchId }))?.headEventHash).toBe("event:loser" as EventHash);
		const retry = await repository.appendWithExpectedHead({
			branchId: created.branchId,
			expectedHeadHash: first.header.headEventHash,
			expectedModeGeneration: GENERATION,
			entries: [entry("loser", "base")],
		});
		expect(retry.header.branchId).toBe(loser.header.branchId);
	});

	it("rejects stale generations inside the same transaction as every publishing write", async () => {
		const adapter = new FakeRuntimeAdapter();
		const repository = new TursoSessionRepository({ adapter });
		const stale = modeGeneration("stale-generation");
		await expect(repository.createSession(sessionRequest("stale", stale))).rejects.toThrow("stale mode generation");
		const created = await repository.createSession(sessionRequest("current"));
		await expect(
			repository.setPinned({ branchId: created.branchId, pinned: true, expectedModeGeneration: stale }),
		).rejects.toThrow("stale mode generation");
		await expect(repository.flush({ expectedModeGeneration: stale })).rejects.toThrow("stale mode generation");
	});

	it("enforces keyset and streaming bounds without unbounded adapter reads", async () => {
		const adapter = new FakeRuntimeAdapter();
		const repository = new TursoSessionRepository({
			adapter,
			defaultPageSize: 2,
			maxPageSize: 2,
			payloadChunkBytes: 2,
			maxPayloadChunkBytes: 2,
		});
		for (const key of ["a", "b", "c", "d"]) await repository.createSession(sessionRequest(key));
		const first = await repository.listSessions({ limit: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).toBeDefined();
		expect(adapter.requestedLimits.at(-1)).toBe(3);
		const second = await repository.listSessions({ limit: 2, cursor: first.nextCursor });
		expect(second.items).toHaveLength(2);
		adapter.returnTooManyRows = true;
		await expect(repository.listSessions({ limit: 2 })).rejects.toThrow("adapter returned 4 rows");
		await expect(collect(repository.readPayload({ payloadHash: "missing" as PayloadHash, chunkBytes: 3 }))).rejects.toThrow(
			"chunkBytes exceeds",
		);
	});

	it("keeps JSONL construction independent and invokes the adapter loader only for explicit DB mode", async () => {
		let dbLoads = 0;
		const jsonl = await createSessionRepository({
			mode: "jsonl",
			rootDir: `/tmp/omp-provider-sentinel-${crypto.randomUUID()}`,
			replicaId: REPLICA_ID,
			modeGeneration: GENERATION,
		});
		const unusedDbLoader = async (): Promise<TursoRuntimeAdapter> => {
			dbLoads++;
			return new FakeRuntimeAdapter();
		};
		expect(unusedDbLoader).toBeDefined();
		expect(jsonl.mode).toBe("jsonl");
		expect(dbLoads).toBe(0);
		await jsonl.close();
		const db = await createSessionRepository({ mode: "db", loadAdapter: unusedDbLoader });
		expect(db.mode).toBe("db");
		expect(dbLoads).toBe(1);
		await db.close();
	});

	it("exposes no filesystem, archive, import, export, or session-path runtime methods", () => {
		const names = Object.getOwnPropertyNames(TursoSessionRepository.prototype);
		expect(names.some(name => /(file|path|archive|import|export|jsonl)/i.test(name))).toBe(false);
	});
});
