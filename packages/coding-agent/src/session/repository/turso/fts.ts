import type { TursoDatabase, TursoTransaction } from "./database";

export const TURSO_SEARCH_INDEX_NAME = "search_documents_fts";
const MAX_SEARCH_QUERY_LENGTH = 2_048;
const MAX_SEARCH_PAGE_SIZE = 100;

export interface TursoSearchDocument {
	eventHash: string;
	originId: string;
	role: string;
	eventTime: number;
	text: string;
}

export interface TursoSearchRequest {
	query: string;
	limit: number;
	offset?: number;
	originId?: string;
	role?: string;
	fromTime?: number;
	toTime?: number;
}

export interface TursoSearchHit {
	eventHash: string;
	originId: string;
	role: string;
	eventTime: number;
	score: number;
	highlightedText: string;
}

export interface TursoSearchPage {
	hits: TursoSearchHit[];
	nextOffset?: number;
}

type SearchWriter = Pick<TursoDatabase, "run"> | Pick<TursoTransaction, "run">;

function assertSearchRequest(request: TursoSearchRequest): void {
	if (!request.query.trim()) throw new Error("Turso FTS query must not be empty");
	if (request.query.length > MAX_SEARCH_QUERY_LENGTH) {
		throw new Error(`Turso FTS query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters`);
	}
	if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_SEARCH_PAGE_SIZE) {
		throw new Error(`Turso FTS limit must be between 1 and ${MAX_SEARCH_PAGE_SIZE}`);
	}
	if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) {
		throw new Error("Turso FTS offset must be a non-negative safe integer");
	}
	for (const [name, value] of [
		["fromTime", request.fromTime],
		["toTime", request.toTime],
	] as const) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			throw new Error(`Turso FTS ${name} must be a non-negative safe integer`);
		}
	}
	if (request.fromTime !== undefined && request.toTime !== undefined && request.fromTime > request.toTime) {
		throw new Error("Turso FTS fromTime must not exceed toTime");
	}
}

export async function upsertTursoSearchDocument(writer: SearchWriter, document: TursoSearchDocument): Promise<void> {
	if (!document.eventHash || !document.originId || !document.role) throw new Error("Search document identity is required");
	if (!Number.isSafeInteger(document.eventTime) || document.eventTime < 0) {
		throw new Error("Search document eventTime must be a non-negative safe integer");
	}
	await writer.run(
		`INSERT INTO search_documents(event_hash, origin_id, role, event_time, text)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(event_hash) DO UPDATE SET
			origin_id = excluded.origin_id,
			role = excluded.role,
			event_time = excluded.event_time,
			text = excluded.text`,
		document.eventHash,
		document.originId,
		document.role,
		document.eventTime,
		document.text,
	);
}

export async function deleteTursoSearchDocument(writer: SearchWriter, eventHash: string): Promise<void> {
	if (!eventHash) throw new Error("Search document event hash is required");
	await writer.run("DELETE FROM search_documents WHERE event_hash = ?", eventHash);
}

interface SearchRow {
	event_hash: string;
	origin_id: string;
	role: string;
	event_time: number | bigint;
	score: number;
	highlighted_text: string;
}

export async function searchTursoDocuments(
	database: Pick<TursoDatabase, "all">,
	request: TursoSearchRequest,
): Promise<TursoSearchPage> {
	assertSearchRequest(request);
	const filters = ["fts_match(text, ?)"];
	const parameters: unknown[] = [request.query, "<mark>", "</mark>", request.query, request.query];
	if (request.originId !== undefined) {
		filters.push("origin_id = ?");
		parameters.push(request.originId);
	}
	if (request.role !== undefined) {
		filters.push("role = ?");
		parameters.push(request.role);
	}
	if (request.fromTime !== undefined) {
		filters.push("event_time >= ?");
		parameters.push(request.fromTime);
	}
	if (request.toTime !== undefined) {
		filters.push("event_time <= ?");
		parameters.push(request.toTime);
	}
	const offset = request.offset ?? 0;
	parameters.push(request.limit + 1, offset);
	const rows = await database.all<SearchRow>(
		`SELECT event_hash, origin_id, role, event_time,
			fts_score(text, ?) AS score,
			fts_highlight(text, ?, ?, ?) AS highlighted_text
		 FROM search_documents
		 WHERE ${filters.join(" AND ")}
		 ORDER BY score DESC, event_time DESC, event_hash ASC
		 LIMIT ? OFFSET ?`,
		...parameters,
	);
	const hasMore = rows.length > request.limit;
	if (hasMore) rows.pop();
	return {
		hits: rows.map(row => ({
			eventHash: row.event_hash,
			originId: row.origin_id,
			role: row.role,
			eventTime: Number(row.event_time),
			score: Number(row.score),
			highlightedText: row.highlighted_text,
		})),
		nextOffset: hasMore ? offset + request.limit : undefined,
	};
}

export async function optimizeTursoSearchIndex(
	database: Pick<TursoDatabase, "exec">,
	queryTimeoutMs?: number,
): Promise<void> {
	await database.exec(
		`OPTIMIZE INDEX ${TURSO_SEARCH_INDEX_NAME}`,
		queryTimeoutMs === undefined ? undefined : { queryTimeout: queryTimeoutMs },
	);
}

export async function verifyTursoSearchIndex(database: Pick<TursoDatabase, "get">): Promise<void> {
	const row = await database.get<{ sql?: string }>(
		"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
		TURSO_SEARCH_INDEX_NAME,
	);
	if (!row?.sql?.includes("USING fts")) throw new Error("Required Turso native FTS index is missing or invalid");
}
