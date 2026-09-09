/**
 * tgrep — conversation/artifact search primitive for the Context Reference
 * neuron's retrieval ladder (tiers 2-4). No model calls, no I/O: pure text
 * scoring over documents already held in memory.
 *
 * Two entry points:
 *  - `tgrep` scores by token overlap, bigram proximity, and recency: the
 *    right tool when the reference text shares words with its antecedent
 *    ("the input side" -> a turn that says "the input side").
 *  - `tgrepByNeighborhood` scores by position: the right tool for demonstrative
 *    references ("that", "he", "the other one") that share NO tokens with
 *    their antecedent and can only be resolved by looking at what was said
 *    nearby.
 */

export type TgrepDocKind = "turn" | "file" | "artifact" | "decision";

export interface TgrepDoc {
	readonly id: string;
	readonly text: string;
	readonly kind: TgrepDocKind;
	/**
	 * 0-based position in the original turn sequence. Only meaningful for
	 * `kind: "turn"` docs; powers the recency bonus in `tgrep` and is required
	 * by `tgrepByNeighborhood` to compute distance from the anchor.
	 */
	readonly turnIndex?: number;
}

export interface TgrepHit {
	readonly docId: string;
	readonly score: number;
	/** The actual matched text, never a boolean stand-in. <=240 chars. */
	readonly excerpt: string;
}

const EXCERPT_LIMIT = 240;

const STOPWORDS: Record<string, true> = {
	the: true, a: true, an: true, and: true, or: true, but: true, if: true, of: true, to: true, in: true, on: true, for: true, with: true,
	is: true, are: true, was: true, were: true, be: true, been: true, being: true, it: true, its: true, this: true, that: true,
	these: true, those: true, i: true, you: true, he: true, she: true, they: true, we: true, me: true, him: true, her: true,
	them: true, us: true, my: true, your: true, his: true, their: true, our: true, do: true, does: true, did: true, not: true,
	so: true, as: true, at: true, by: true, from: true, up: true, out: true, about: true, into: true, over: true, just: true,
	than: true, then: true, there: true, here: true, what: true, which: true, who: true, whom: true, how: true, why: true,
	can: true, could: true, should: true, would: true, will: true, shall: true, may: true, might: true, one: true,
	other: true, same: true, again: true, please: true, okay: true, yes: true, no: true,
};

function tokenize(text: string): string[] {
	const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_'-]*/g);
	return matches ?? [];
}

/** True when some consecutive pair of needle tokens also appears consecutively in doc tokens. */
function hasAdjacentPair(needleTokens: readonly string[], docTokens: readonly string[]): boolean {
	if (needleTokens.length < 2) return false;
	for (let i = 0; i < needleTokens.length - 1; i++) {
		const a = needleTokens[i];
		const b = needleTokens[i + 1];
		for (let j = 0; j < docTokens.length - 1; j++) {
			if (docTokens[j] === a && docTokens[j + 1] === b) return true;
		}
	}
	return false;
}

function clampExcerpt(text: string, aroundIndex: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= EXCERPT_LIMIT) return trimmed;
	const half = Math.floor(EXCERPT_LIMIT / 2);
	const start = Math.max(0, Math.min(aroundIndex - half, trimmed.length - EXCERPT_LIMIT));
	return trimmed.slice(start, start + EXCERPT_LIMIT).trim();
}

function buildOverlapExcerpt(text: string, matchedTokens: readonly string[]): string {
	const lower = text.toLowerCase();
	let bestIndex = -1;
	for (const token of matchedTokens) {
		const idx = lower.indexOf(token);
		if (idx >= 0 && (bestIndex === -1 || idx < bestIndex)) bestIndex = idx;
	}
	return clampExcerpt(text, bestIndex >= 0 ? bestIndex : 0);
}

export interface TgrepOptions {
	/** Cap the number of hits returned, highest score first. */
	readonly limit?: number;
	/**
	 * Turn index the search is being run "as of" — later docs get a small
	 * recency bonus the closer they sit to this anchor. Defaults to the
	 * corpus length (i.e. "now", favoring the most recent doc supplied).
	 */
	readonly anchorIndex?: number;
}

/**
 * Token-overlap search: needle vs. corpus. Beats naive substring matching via
 * three signals — overlap ratio, bigram adjacency, and recency — so that a
 * paraphrased reference ("the input side") still finds a turn that used the
 * same distinctive words even without an exact substring match.
 */
export function tgrep(needle: string, corpus: readonly TgrepDoc[], opts: TgrepOptions = {}): TgrepHit[] {
	const needleTokens = tokenize(needle).filter(t => !STOPWORDS[t] && t.length > 1);
	if (needleTokens.length === 0) return [];
	const anchor = opts.anchorIndex ?? corpus.length;

	const hits: TgrepHit[] = [];
	for (const doc of corpus) {
		const docTokens = tokenize(doc.text);
		const docTokenSet = new Set(docTokens);
		const overlap = needleTokens.filter(t => docTokenSet.has(t));
		if (overlap.length === 0) continue;

		const overlapScore = (overlap.length / needleTokens.length) * 10;
		const proximityBonus = hasAdjacentPair(needleTokens, docTokens) ? 3 : 0;
		const recencyBonus =
			typeof doc.turnIndex === "number" ? Math.max(0, 5 - Math.abs(anchor - doc.turnIndex)) * 0.2 : 0;

		hits.push({
			docId: doc.id,
			score: overlapScore + proximityBonus + recencyBonus,
			excerpt: buildOverlapExcerpt(doc.text, overlap),
		});
	}

	hits.sort((a, b) => b.score - a.score);
	return typeof opts.limit === "number" ? hits.slice(0, opts.limit) : hits;
}

export interface NeighborhoodOptions {
	/** How many turns before the anchor to consider. Default 6. */
	readonly window?: number;
	readonly limit?: number;
}

/** A capitalized word, a backticked/quoted span, or a long lowercase word — candidate antecedent nouns. */
function extractDistinctiveTerms(text: string): string[] {
	const terms = new Set<string>();
	for (const m of text.matchAll(/`([^`]+)`/g)) terms.add(m[1].trim());
	for (const m of text.matchAll(/"([^"]+)"/g)) terms.add(m[1].trim());
	for (const m of text.matchAll(/\*\*([^*]+)\*\*/g)) terms.add(m[1].trim());
	for (const m of text.matchAll(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)) terms.add(m[0]);
	for (const token of tokenize(text).filter(t => !STOPWORDS[t] && t.length > 1)) {
		if (token.length >= 5) terms.add(token);
	}
	return Array.from(terms).filter(t => t.length > 0 && t.length <= 60);
}

function buildNeighborhoodExcerpt(text: string, terms: readonly string[]): string {
	if (terms.length === 0) return clampExcerpt(text, 0);
	const lower = text.toLowerCase();
	const idx = lower.indexOf(terms[0].toLowerCase());
	return clampExcerpt(text, idx >= 0 ? idx : 0);
}

/**
 * Positional resolution for demonstratives ("that", "he", "the other one")
 * that share no vocabulary with their antecedent. Ranks candidate turns by
 * distance from `turnIndex` (nearer wins) and by how many distinctive terms
 * (identifiers, quoted/backticked spans, capitalized words) each candidate
 * offers as a plausible binding — since a turn with nothing distinctive in it
 * cannot be what a pronoun points to.
 */
export function tgrepByNeighborhood(
	referenceText: string,
	turnIndex: number,
	corpus: readonly TgrepDoc[],
	opts: NeighborhoodOptions = {},
): TgrepHit[] {
	const window = opts.window ?? 6;
	const candidates = corpus.filter(
		d => typeof d.turnIndex === "number" && d.turnIndex < turnIndex && turnIndex - d.turnIndex <= window,
	);

	const hits: TgrepHit[] = [];
	for (const doc of candidates) {
		const distance = turnIndex - (doc.turnIndex as number);
		const terms = extractDistinctiveTerms(doc.text);
		if (terms.length === 0) continue;

		const proximityScore = Math.max(0, 10 - distance);
		const richnessBonus = Math.min(3, terms.length * 0.5);

		hits.push({
			docId: doc.id,
			score: proximityScore + richnessBonus,
			excerpt: buildNeighborhoodExcerpt(doc.text, terms),
		});
	}

	hits.sort((a, b) => b.score - a.score);
	void referenceText; // reserved for future term-affinity weighting; position dominates today
	return typeof opts.limit === "number" ? hits.slice(0, opts.limit) : hits;
}
