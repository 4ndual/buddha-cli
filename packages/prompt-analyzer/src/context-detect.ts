/**
 * The Context Reference detector's parsing and free-tier binding.
 *
 * `parseContextDetection` is strict on purpose: the resolver locates references by
 * exact span, so a hallucinated or paraphrased span is a hard failure, not a
 * degraded result. Detection never resolves; `resolveTier01` is the first thing
 * that does, and only over material already in memory.
 */

import {
	type ContextDetection,
	type DetectedReference,
	isReferenceSource,
	type ResolvedReference,
	TOPIC_DIGEST_CHARS,
} from "./context-contracts";
import { buildGlossary, buildTopicDigest, cleanConversationText, lookupGlossary, sentenceAround } from "./glossary";
import { isRecord } from "./validate";

type Turn = { role: string; text: string };

/** Words that carry no searchable content: matching them binds nothing. */
const OPAQUE_WORDS: Record<string, true> = {
	a: true,
	again: true,
	an: true,
	and: true,
	both: true,
	each: true,
	here: true,
	his: true,
	her: true,
	it: true,
	its: true,
	my: true,
	one: true,
	our: true,
	same: true,
	that: true,
	the: true,
	their: true,
	them: true,
	there: true,
	these: true,
	they: true,
	this: true,
	those: true,
	your: true,
};

/** The JSON object inside a model response that may carry prose or a code fence. */
function extractJsonObject(raw: string): string {
	const text = raw.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const body = (fenced?.[1] ?? text).trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end === -1 || end < start) {
		throw new Error("detect_context: response contains no JSON object");
	}
	return body.slice(start, end + 1);
}

/**
 * Parse and validate a detector response against the prompt it describes.
 * Throws with a precise reason on any violation; the caller reports stage_failed.
 */
export function parseContextDetection(raw: string, prompt: string): ContextDetection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonObject(raw));
	} catch (error) {
		throw new Error(`detect_context: response is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!isRecord(parsed)) throw new Error("detect_context: response is not a JSON object");

	const needsContext = parsed.needs_context;
	const selfContained = parsed.self_contained;
	if (typeof needsContext !== "boolean") {
		throw new Error(`detect_context: "needs_context" must be a boolean, got ${JSON.stringify(needsContext)}`);
	}
	if (typeof selfContained !== "boolean") {
		throw new Error(`detect_context: "self_contained" must be a boolean, got ${JSON.stringify(selfContained)}`);
	}
	const rawReferences = parsed.references;
	if (!Array.isArray(rawReferences)) {
		throw new Error(`detect_context: "references" must be an array, got ${JSON.stringify(rawReferences)}`);
	}

	const references: DetectedReference[] = rawReferences.map((entry, i) => {
		if (!isRecord(entry)) throw new Error(`detect_context: references[${i}] is not an object`);

		const text = entry.text;
		if (typeof text !== "string" || text.trim().length === 0) {
			throw new Error(`detect_context: references[${i}].text must be a non-empty string`);
		}
		if (!prompt.includes(text)) {
			throw new Error(`detect_context: references[${i}].text ${JSON.stringify(text)} is not verbatim in the prompt`);
		}

		const pointsToRaw = entry.points_to;
		if (pointsToRaw !== null && typeof pointsToRaw !== "string") {
			throw new Error(`detect_context: references[${i}].points_to must be a string or null`);
		}
		const pointsTo = typeof pointsToRaw === "string" && pointsToRaw.trim().length > 0 ? pointsToRaw : null;

		const sourceRaw = entry.source;
		if (sourceRaw !== null && !isReferenceSource(sourceRaw)) {
			throw new Error(`detect_context: references[${i}].source ${JSON.stringify(sourceRaw)} is not a known source kind`);
		}

		const weight = entry.weight;
		if (weight !== "material" && weight !== "incidental") {
			throw new Error(`detect_context: references[${i}].weight must be "material" or "incidental", got ${JSON.stringify(weight)}`);
		}

		return { text, pointsTo, source: sourceRaw, weight };
	});

	if (selfContained && references.length > 0) {
		throw new Error(`detect_context: self_contained is true but ${references.length} reference(s) were reported`);
	}
	if (!selfContained && references.length === 0) {
		throw new Error("detect_context: self_contained is false but no references were reported");
	}
	if (needsContext && references.length === 0) {
		throw new Error("detect_context: needs_context is true but no references were reported");
	}
	if (!needsContext && references.some(reference => reference.weight === "material")) {
		throw new Error("detect_context: needs_context is false but a material reference was reported");
	}

	return { needsContext, references, selfContained };
}

/** A prompt is self-contained when it carries no reference of any weight. */
export function isSelfContained(detection: ContextDetection): boolean {
	return !detection.needsContext && detection.references.length === 0;
}

/** True when a phrase has any word worth searching for. */
function searchable(phrase: string): boolean {
	const words = phrase
		.toLowerCase()
		.replace(/[^a-z0-9./~:_\- ]+/g, " ")
		.split(/\s+/)
		.filter(word => word.length > 0);
	if (words.length === 0) return false;
	return words.some(word => word.length >= 3 && OPAQUE_WORDS[word] !== true);
}

/** Leading determiners a reference carries that the searched text may not. */
const LEADING_DETERMINER = /^\s*(?:the|a|an|this|that|these|those|my|your|our|its|their)\s+/i;

/** First occurrence of any candidate phrase in `text`, returned as evidence. */
function bindInText(text: string, candidates: readonly string[]): string | null {
	if (text.length === 0) return null;
	const haystack = text.toLowerCase();
	for (const candidate of candidates) {
		const needle = candidate.replace(LEADING_DETERMINER, "").trim().toLowerCase();
		if (needle.length < 3 || !searchable(needle)) continue;
		const index = haystack.indexOf(needle);
		if (index === -1) continue;
		const evidence = sentenceAround(text, index);
		if (evidence.trim().length > 0) return evidence;
	}
	return null;
}

/**
 * Tiers 0 and 1 of the ladder, both free: bind against the last turn (tier 0),
 * then the autogenerated glossary and rolling topic digest (tier 1).
 * A reference is only ever marked resolved together with the text that bound it.
 */
export function resolveTier01(detection: ContextDetection, turns: readonly Turn[]): ResolvedReference[] {
	const lastTurn = turns.length > 0 ? cleanConversationText((turns[turns.length - 1] as Turn).text) : "";
	const digest = buildTopicDigest(turns);
	const glossary = buildGlossary(turns);

	return detection.references.map(reference => {
		const candidates = reference.pointsTo === null ? [reference.text] : [reference.text, reference.pointsTo];

		const inLastTurn = bindInText(lastTurn, candidates);
		if (inLastTurn !== null) {
			return { ...reference, resolved: true, evidence: inLastTurn, resolvedByTier: 0 };
		}

		for (const candidate of candidates) {
			const entry = lookupGlossary(glossary, candidate);
			if (entry === null) continue;
			const evidence = entry.definition.trim();
			if (evidence.length === 0) continue;
			return {
				...reference,
				resolved: true,
				evidence: evidence.slice(0, TOPIC_DIGEST_CHARS),
				resolvedByTier: 1,
			};
		}

		const inDigest = bindInText(digest, candidates);
		if (inDigest !== null) {
			return { ...reference, resolved: true, evidence: inDigest, resolvedByTier: 1 };
		}

		return { ...reference, resolved: false, evidence: "", resolvedByTier: null };
	});
}
