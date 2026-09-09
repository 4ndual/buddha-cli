/**
 * Builders for well-formed (and deliberately broken) stage JSON text,
 * matching the wire shapes in `src/stage-prompts.ts` exactly.
 */

export function paraphraseResponse(parts: Array<{ source: string; paraphrase: string }>, summary?: string): string {
	return JSON.stringify({
		paraphrase: summary ?? parts.map(p => p.paraphrase).join(" "),
		parts,
	});
}

export function categorizeResponse(parts: Array<{ text: string; categories: string[] }>): string {
	return JSON.stringify({ parts });
}

export function analyzeResponse(
	parts: Array<{ text: string; subcategories: string[]; tags: string[] }>,
	intent: Array<{ id: string; answer: string; source: string }>,
): string {
	return JSON.stringify({ parts, intent });
}

export interface VerifyOverrides {
	category_match?: boolean;
	subcategory_match?: boolean;
	meaning_coverage?: number;
	invented_meaning_count?: number;
	lost_meaning_count?: number;
	coherent?: boolean;
	problems?: Array<{ type: string; message: string; source?: string }>;
}

export function verifyResponse(overrides: VerifyOverrides): string {
	return JSON.stringify({
		category_match: true,
		subcategory_match: true,
		meaning_coverage: 1,
		invented_meaning_count: 0,
		lost_meaning_count: 0,
		coherent: true,
		problems: [],
		...overrides,
	});
}
