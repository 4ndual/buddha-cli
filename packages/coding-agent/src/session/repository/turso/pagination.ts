export interface KeysetPosition {
	/** Stable, normalized primary sort value chosen by the query adapter. */
	sortKey: string;
	/** Stable tie-breaker; must be unique within the result set. */
	id: string;
}

export interface KeysetPage<T> {
	items: readonly T[];
	nextCursor?: string;
}

export interface PageSizeOptions {
	defaultSize?: number;
	maxSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGE_SIZE = 500;

export function normalizePageSize(requested: number | undefined, options: PageSizeOptions = {}): number {
	const defaultSize = options.defaultSize ?? DEFAULT_PAGE_SIZE;
	const maxSize = options.maxSize ?? DEFAULT_MAX_PAGE_SIZE;
	if (!Number.isSafeInteger(defaultSize) || defaultSize < 1) throw new RangeError("default page size must be positive");
	if (!Number.isSafeInteger(maxSize) || maxSize < defaultSize) {
		throw new RangeError("maximum page size must be at least the default page size");
	}
	if (requested === undefined) return defaultSize;
	if (!Number.isSafeInteger(requested) || requested < 1) throw new RangeError("page size must be a positive integer");
	return Math.min(requested, maxSize);
}

export function encodeKeyset(position: KeysetPosition): string {
	assertPosition(position);
	return Buffer.from(JSON.stringify([position.sortKey, position.id]), "utf8").toString("base64url");
}

export function decodeKeyset(cursor: string | undefined): KeysetPosition | undefined {
	if (cursor === undefined) return undefined;
	if (cursor.length === 0 || cursor.length > 4096) throw new Error("invalid pagination cursor");
	try {
		const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error("invalid tuple");
		const position = { sortKey: decoded[0], id: decoded[1] };
		assertPosition(position);
		return position;
	} catch (error) {
		if (error instanceof Error && error.message === "invalid pagination cursor") throw error;
		throw new Error("invalid pagination cursor", { cause: error });
	}
}

/**
 * Converts an adapter result fetched with `limit + 1` into an opaque keyset page.
 * The extra row is never exposed or retained.
 */
export function keysetPage<T>(rows: readonly T[], limit: number, positionOf: (row: T) => KeysetPosition): KeysetPage<T> {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("page limit must be positive");
	if (rows.length > limit + 1) throw new Error(`adapter returned ${rows.length} rows for a ${limit + 1}-row query`);
	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows.slice();
	const last = items.at(-1);
	return {
		items,
		nextCursor: hasMore && last !== undefined ? encodeKeyset(positionOf(last)) : undefined,
	};
}

function assertPosition(value: unknown): asserts value is KeysetPosition {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as KeysetPosition).sortKey !== "string" ||
		typeof (value as KeysetPosition).id !== "string" ||
		(value as KeysetPosition).sortKey.length === 0 ||
		(value as KeysetPosition).id.length === 0
	) {
		throw new Error("invalid pagination cursor");
	}
}
