import type {
	BranchId,
	ContextTail,
	EventHash,
	Page,
	RepositoryCursor,
	RepositorySessionHeader,
	SessionListQuery,
	SessionRepository,
	SessionSearchHit,
	SessionSearchQuery,
	SessionTreeEvent,
	StorageMode,
} from "../../contracts";

export class StoragePathUnavailableError extends Error {
	readonly mode: StorageMode;
	readonly branchId: BranchId;

	constructor(mode: StorageMode, branchId: BranchId) {
		super(
			mode === "db"
				? `Branch ${branchId} has no session JSONL path in Database mode. Export the branch explicitly or switch to JSONL mode.`
				: `No JSONL path is registered for branch ${branchId}.`,
		);
		this.name = "StoragePathUnavailableError";
		this.mode = mode;
		this.branchId = branchId;
	}
}

export interface SessionConsumerStats {
	sessions: number;
	entries: number;
	messages: number;
	payloadBytes: number;
}

export interface SessionRepositoryConsumerAdapterOptions {
	readonly jsonlPathForBranch?: (branchId: BranchId) => Promise<string | undefined>;
}

/**
 * Incremental compatibility surface for list/search/resume/history/stats/memory
 * consumers. Database mode never invokes the optional JSONL path resolver.
 */
export class SessionRepositoryConsumerAdapter {
	readonly #repository: SessionRepository;
	readonly #jsonlPathForBranch?: (branchId: BranchId) => Promise<string | undefined>;

	constructor(repository: SessionRepository, options: SessionRepositoryConsumerAdapterOptions = {}) {
		this.#repository = repository;
		this.#jsonlPathForBranch = options.jsonlPathForBranch;
	}

	list(query: SessionListQuery = {}): Promise<Page<RepositorySessionHeader>> {
		return this.#repository.listSessions(query);
	}

	search(query: SessionSearchQuery): Promise<Page<SessionSearchHit>> {
		return this.#repository.searchSessions(query);
	}

	resume(
		branchId: BranchId,
		options: { maxEntries: number; maxPayloadBytes: number; afterHash?: EventHash | null; throughHash?: EventHash | null },
	): Promise<ContextTail> {
		return this.#repository.readContextTail({ branchId, ...options });
	}

	async *history(branchId: BranchId, pageSize = 100): AsyncIterable<readonly SessionTreeEvent[]> {
		let cursor: RepositoryCursor | undefined;
		do {
			const page = await this.#repository.listTree({ branchId, direction: "ancestors", limit: pageSize, cursor });
			if (page.items.length > 0) yield page.items;
			cursor = page.nextCursor;
		} while (cursor);
	}

	async stats(pageSize = 100): Promise<SessionConsumerStats> {
		let cursor: RepositoryCursor | undefined;
		const totals: SessionConsumerStats = { sessions: 0, entries: 0, messages: 0, payloadBytes: 0 };
		do {
			const page = await this.#repository.listSessions({ limit: pageSize, cursor });
			for (const session of page.items) {
				totals.sessions++;
				totals.entries += session.entryCount;
				totals.messages += session.messageCount;
				totals.payloadBytes += session.payloadBytes;
			}
			cursor = page.nextCursor;
		} while (cursor);
		return totals;
	}

	async *memory(query: SessionSearchQuery): AsyncIterable<readonly SessionSearchHit[]> {
		let cursor = query.cursor;
		do {
			const page = await this.#repository.searchSessions({ ...query, cursor });
			if (page.items.length > 0) yield page.items;
			cursor = page.nextCursor;
		} while (cursor);
	}

	async pathForExtension(branchId: BranchId): Promise<string> {
		if (this.#repository.mode === "db") throw new StoragePathUnavailableError("db", branchId);
		const path = await this.#jsonlPathForBranch?.(branchId);
		if (!path) throw new StoragePathUnavailableError("jsonl", branchId);
		return path;
	}
}
