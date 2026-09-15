import type {
	BranchId,
	EventHash,
	KeysetCursor,
	KeysetPage,
	OriginId,
	RepositoryEvent,
	SessionRepository,
	VersionId,
} from "../session/repository/types";

export interface RepositoryHistoryEntry {
	originId: OriginId;
	branchId: BranchId;
	versionId: VersionId;
	eventHash?: EventHash;
	prompt: string;
	createdAt: number;
	cwd?: string;
}

export interface RepositoryHistorySearchQuery {
	text: string;
	limit?: number;
	cursor?: KeysetCursor;
	originId?: OriginId;
}

export interface RepositoryHistoryRecentOptions {
	limit: number;
	sessionPageSize?: number;
	eventPageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_RESULT_LIMIT = 1_000;

/**
 * Repository-native prompt/history projection. It reads only logical session
 * pages and event pages; it never opens history.db or a session JSONL file.
 */
export class RepositoryHistoryProjection {
	readonly #repository: SessionRepository;

	constructor(options: { repository: SessionRepository }) {
		this.#repository = options.repository;
	}

	/** Search uses the active repository's native bounded search projection. */
	async search(query: RepositoryHistorySearchQuery): Promise<KeysetPage<RepositoryHistoryEntry>> {
		const limit = normalizeLimit(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
		if (limit === 0) return { items: [] };
		const page = await this.#repository.search({
			text: query.text,
			limit,
			cursor: query.cursor,
			originId: query.originId,
		});
		return {
			items: page.items.map(hit => ({
				originId: hit.header.originId,
				branchId: hit.header.branchId,
				versionId: hit.header.versionId,
				eventHash: hit.eventHash,
				prompt: hit.snippet,
				createdAt: Date.parse(hit.header.modifiedAt) || 0,
				cwd: hit.header.metadata.cwd,
			})),
			nextCursor: page.nextCursor,
		};
	}

	/**
	 * Return recent user prompts without consulting the JSONL history index.
	 * Both outer session traversal and inner event traversal use keyset pages,
	 * and the requested result limit is a hard materialization bound.
	 */
	async recent(options: RepositoryHistoryRecentOptions): Promise<RepositoryHistoryEntry[]> {
		const limit = normalizeLimit(options.limit, MAX_RESULT_LIMIT);
		if (limit === 0) return [];
		const sessionPageSize = normalizePageSize(options.sessionPageSize);
		const eventPageSize = normalizePageSize(options.eventPageSize);
		const entries: RepositoryHistoryEntry[] = [];
		const seen = new Set<string>();
		let sessionCursor: KeysetCursor | undefined;
		do {
			const sessions = await this.#repository.listSessions({ limit: sessionPageSize, cursor: sessionCursor });
			for (const header of sessions.items) {
				let eventCursor: KeysetCursor | undefined;
				do {
					const events = await this.#repository.readEvents({
						branchId: header.branchId,
						versionId: header.versionId,
						limit: eventPageSize,
						cursor: eventCursor,
					});
					for (const event of events.items) {
						const prompt = userPrompt(event);
						if (!prompt || seen.has(prompt)) continue;
						seen.add(prompt);
						entries.push({
							originId: header.originId,
							branchId: header.branchId,
							versionId: header.versionId,
							eventHash: event.eventHash,
							prompt,
							createdAt: eventTimestamp(event),
							cwd: header.metadata.cwd,
						});
						if (entries.length >= limit) break;
					}
					eventCursor = events.nextCursor;
				} while (eventCursor && entries.length < limit);
				if (entries.length >= limit) break;
			}
			sessionCursor = sessions.nextCursor;
		} while (sessionCursor && entries.length < limit);
		return entries
			.sort((a, b) => b.createdAt - a.createdAt || String(b.eventHash).localeCompare(String(a.eventHash)))
			.slice(0, limit);
	}
}

function normalizeLimit(limit: number, maximum: number): number {
	if (!Number.isFinite(limit)) return 0;
	return Math.max(0, Math.min(maximum, Math.floor(limit)));
}

function normalizePageSize(value: number | undefined): number {
	return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(value ?? DEFAULT_PAGE_SIZE)));
}

function userPrompt(event: RepositoryEvent): string | undefined {
	const entry = event.entry;
	if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) return undefined;
	const text = messageText(entry.message.content).trim();
	return text || undefined;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block)) {
				return "";
			}
			return typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function eventTimestamp(event: RepositoryEvent): number {
	if (!("timestamp" in event.entry)) return 0;
	const timestamp = event.entry.timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	if (typeof timestamp !== "string") return 0;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}
