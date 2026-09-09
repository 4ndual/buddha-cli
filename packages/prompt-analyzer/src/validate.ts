/**
 * Stage-result validation.
 *
 * A model result becomes pipeline state only after this file accepts it. The
 * rules are the spec's: exact source spans must exist in the raw prompt,
 * categories/subcategories/question ids must exist in the fixed registries,
 * subcategories must belong to their part's categories, intent answers need
 * prompt evidence (or explicit non-user provenance), and `meaning_coverage`
 * must be a fraction.
 *
 * Two deliberate policies:
 * - **Unknown fields are ignored, never fatal.** Every accepted value is a
 *   freshly normalized object holding only known fields, so a model that adds
 *   `confidence` or `notes` neither breaks the run nor leaks into UI state.
 * - **Every error is reported**, not just the first, so one bad span does not
 *   hide four others.
 */

import type { ContextDetection } from "./context-contracts";
import { parseContextDetection } from "./context-detect";
import type { Stage } from "./contracts";
import { CATEGORIES, EXCLUDED_QUESTION_PREFIX, INTENT_QUESTIONS, isCategory, isSubcategoryOf } from "./registry";

/**
 * Question ids the registry marks `"always"` (INT-01 and INT-10). "Always
 * evaluated" means always *answered*, not merely always asked — but a missing
 * answer is reported as a problem, never as a fatal stage error, so a usable
 * analysis still reaches the browser.
 */
export const REQUIRED_INTENT_IDS: readonly string[] = Object.entries(INTENT_QUESTIONS)
	.filter(([, question]) => question.categories === "always")
	.map(([id]) => id);

/** Required question ids with no non-empty answer in `intent`. */
export function missingRequiredIntentIds(intent: readonly { id: string; answer: string }[]): string[] {
	return REQUIRED_INTENT_IDS.filter(
		required => !intent.some(answer => answer.id === required && answer.answer.trim().length > 0),
	);
}

/** Normalized `paraphrase` stage result. */
export interface ParaphrasePart {
	source: string;
	paraphrase: string;
}
export interface ParaphraseResult {
	paraphrase: string;
	parts: ParaphrasePart[];
}

/** Normalized `categorize` stage result. */
export interface CategorizePart {
	text: string;
	categories: string[];
	/**
	 * Referring words this part contains, verbatim. A detection signal only:
	 * the `detect_context` stage is authoritative, this is the categorizer
	 * noticing the same thing from the other side.
	 */
	references: string[];
}
export interface CategorizeResult {
	parts: CategorizePart[];
	/** The categorizer's own verdict that this message leans on something outside itself. */
	needsContext: boolean;
}

/** Normalized `analyze` stage result. */
export interface AnalyzePart {
	text: string;
	subcategories: string[];
	tags: string[];
}
export interface AnalyzeIntentAnswer {
	id: string;
	answer: string;
	source: string;
}
export interface AnalyzeResult {
	parts: AnalyzePart[];
	intent: AnalyzeIntentAnswer[];
}

/** Normalized `verify` stage result, in the spec's snake_case wire shape. */
export interface VerifyProblem {
	type: string;
	message: string;
	source?: string;
}
export interface VerifyResult {
	category_match: boolean;
	subcategory_match: boolean;
	meaning_coverage: number;
	invented_meaning_count: number;
	lost_meaning_count: number;
	coherent: boolean;
	problems: VerifyProblem[];
}

/** Context a stage result is checked against. */
export interface ValidationContext {
	rawPrompt: string;
	/** Categories detected by the `categorize` stage; scopes allowed subcategories. */
	categories?: string[];
}

export type ValidationOutcome = { ok: true; value: unknown } | { ok: false; errors: string[] };

/**
 * Answers to INT-10 ("which claims came from the user, model, tool or
 * guideline?") legitimately cite non-user provenance, for which no span of the
 * user's prompt exists. Those markers stand in for a source span.
 */
const NON_USER_PROVENANCE: Record<string, true> = {
	model: true,
	tool: true,
	guideline: true,
	agent: true,
	system: true,
	none: true,
	"n/a": true,
	"-": true,
	"": true,
};

/**
 * The package's single object guard. Model results arrive as `unknown` at this
 * boundary; every field is then read explicitly by the validators below.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve a claimed source span against the raw prompt.
 *
 * Leading/trailing whitespace is not part of a span, so a trimmed match is
 * accepted and the trimmed form becomes the stored source. Anything else is a
 * fabricated span.
 */
function resolveSpan(claim: string, rawPrompt: string): string | undefined {
	if (claim.length > 0 && rawPrompt.includes(claim)) return claim;
	const trimmed = claim.trim();
	if (trimmed.length > 0 && rawPrompt.includes(trimmed)) return trimmed;
	return undefined;
}

/** Read a required string field, recording an error when it is missing or empty. */
function readString(
	source: Record<string, unknown>,
	field: string,
	where: string,
	errors: string[],
): string | undefined {
	const value = source[field];
	if (typeof value !== "string") {
		errors.push(`${where}: "${field}" must be a string`);
		return undefined;
	}
	if (value.trim().length === 0) {
		errors.push(`${where}: "${field}" must not be empty`);
		return undefined;
	}
	return value;
}

/** Read an array field, recording an error when it is present but not an array. */
function readArray(source: Record<string, unknown>, field: string, where: string, errors: string[]): unknown[] {
	const value = source[field];
	if (value === undefined) {
		errors.push(`${where}: "${field}" is required`);
		return [];
	}
	if (!Array.isArray(value)) {
		errors.push(`${where}: "${field}" must be an array`);
		return [];
	}
	return value;
}

/** Collect the string entries of a list field, reporting non-strings. */
function readStringList(value: unknown[], where: string, field: string, errors: string[]): string[] {
	const out: string[] = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			errors.push(`${where}: ${field}[${index}] must be a non-empty string`);
			continue;
		}
		out.push(entry.trim());
	}
	return out;
}

function readBoolean(source: Record<string, unknown>, field: string, errors: string[]): boolean {
	const value = source[field];
	if (typeof value !== "boolean") {
		errors.push(`verify: "${field}" must be a boolean`);
		return false;
	}
	return value;
}

function readCount(source: Record<string, unknown>, field: string, errors: string[]): number {
	const value = source[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		errors.push(`verify: "${field}" must be a number >= 0`);
		return 0;
	}
	return value;
}

function validateParaphrase(raw: unknown, ctx: ValidationContext, errors: string[]): ParaphraseResult | undefined {
	if (!isRecord(raw)) {
		errors.push("paraphrase: result must be a JSON object");
		return undefined;
	}
	const paraphrase = readString(raw, "paraphrase", "paraphrase", errors);
	const parts: ParaphrasePart[] = [];
	for (const [index, entry] of readArray(raw, "parts", "paraphrase", errors).entries()) {
		const where = `paraphrase: parts[${index}]`;
		if (!isRecord(entry)) {
			errors.push(`${where} must be an object`);
			continue;
		}
		const claim = readString(entry, "source", where, errors);
		const partParaphrase = readString(entry, "paraphrase", where, errors);
		if (claim === undefined || partParaphrase === undefined) continue;
		const span = resolveSpan(claim, ctx.rawPrompt);
		if (span === undefined) {
			errors.push(`${where}: source is not verbatim in the prompt: ${JSON.stringify(claim)}`);
			continue;
		}
		parts.push({ source: span, paraphrase: partParaphrase });
	}
	if (paraphrase === undefined) return undefined;
	if (parts.length === 0) errors.push("paraphrase: at least one part with a verbatim source is required");
	return { paraphrase, parts };
}

function validateCategorize(raw: unknown, ctx: ValidationContext, errors: string[]): CategorizeResult | undefined {
	if (!isRecord(raw)) {
		errors.push("categorize: result must be a JSON object");
		return undefined;
	}
	const parts: CategorizePart[] = [];
	for (const [index, entry] of readArray(raw, "parts", "categorize", errors).entries()) {
		const where = `categorize: parts[${index}]`;
		if (!isRecord(entry)) {
			errors.push(`${where} must be an object`);
			continue;
		}
		const claim = readString(entry, "text", where, errors);
		const rawCategories = readStringList(readArray(entry, "categories", where, errors), where, "categories", errors);
		// `references` is optional and never fatal: detect_context owns reference
		// detection, so a categorizer that omits the field, or names words it did
		// not quote exactly, must not cost the run its categories.
		const rawReferences = Array.isArray(entry.references)
			? entry.references.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			: [];
		if (claim === undefined) continue;
		const span = resolveSpan(claim, ctx.rawPrompt);
		if (span === undefined) {
			errors.push(`${where}: text is not verbatim in the prompt: ${JSON.stringify(claim)}`);
			continue;
		}
		const categories = rawCategories.filter(category => {
			if (isCategory(category)) return true;
			errors.push(`${where}: unknown category ${JSON.stringify(category)}`);
			return false;
		});
		if (categories.length === 0) {
			errors.push(`${where}: needs at least one of ${Object.keys(CATEGORIES).join(", ")}`);
			continue;
		}
		const references: string[] = [];
		for (const reference of rawReferences) {
			const referenceSpan = resolveSpan(reference, ctx.rawPrompt);
			if (referenceSpan !== undefined && !references.includes(referenceSpan)) references.push(referenceSpan);
		}
		parts.push({ text: span, categories, references });
	}
	if (parts.length === 0) errors.push("categorize: at least one categorized part is required");
	// An explicit `needs_context: true` is honoured; an omitted flag is derived
	// from the references the same result carries, never assumed false.
	const needsContext = raw.needs_context === true || parts.some(part => part.references.length > 0);
	return { parts, needsContext };
}

function validateAnalyze(raw: unknown, ctx: ValidationContext, errors: string[]): AnalyzeResult | undefined {
	if (!isRecord(raw)) {
		errors.push("analyze: result must be a JSON object");
		return undefined;
	}
	// Subcategories are only valid inside a detected category. With no detected
	// set supplied, fall back to "belongs to some category" so a caller that
	// skips the context still rejects invented subcategories.
	const scope = (ctx.categories ?? Object.keys(CATEGORIES)).filter(isCategory);
	const parts: AnalyzePart[] = [];
	for (const [index, entry] of readArray(raw, "parts", "analyze", errors).entries()) {
		const where = `analyze: parts[${index}]`;
		if (!isRecord(entry)) {
			errors.push(`${where} must be an object`);
			continue;
		}
		const claim = readString(entry, "text", where, errors);
		const rawSubcategories = readStringList(
			readArray(entry, "subcategories", where, errors),
			where,
			"subcategories",
			errors,
		);
		const tags = Array.isArray(entry.tags) ? readStringList(entry.tags, where, "tags", errors) : [];
		if (claim === undefined) continue;
		const span = resolveSpan(claim, ctx.rawPrompt);
		if (span === undefined) {
			errors.push(`${where}: text is not verbatim in the prompt: ${JSON.stringify(claim)}`);
			continue;
		}
		const subcategories = rawSubcategories.filter(subcategory => {
			if (scope.some(category => isSubcategoryOf(category, subcategory))) return true;
			errors.push(
				`${where}: subcategory ${JSON.stringify(subcategory)} does not belong to ${scope.join(", ")}`,
			);
			return false;
		});
		parts.push({ text: span, subcategories, tags });
	}
	if (parts.length === 0) errors.push("analyze: at least one part is required");

	const intent: AnalyzeIntentAnswer[] = [];
	for (const [index, entry] of readArray(raw, "intent", "analyze", errors).entries()) {
		const where = `analyze: intent[${index}]`;
		if (!isRecord(entry)) {
			errors.push(`${where} must be an object`);
			continue;
		}
		const id = readString(entry, "id", where, errors);
		const answer = readString(entry, "answer", where, errors);
		if (id === undefined || answer === undefined) continue;
		if (id.startsWith(EXCLUDED_QUESTION_PREFIX)) {
			errors.push(`${where}: ${id} is excluded from this MVP`);
			continue;
		}
		if (!Object.hasOwn(INTENT_QUESTIONS, id)) {
			errors.push(`${where}: unknown question id ${JSON.stringify(id)}`);
			continue;
		}
		const claim = typeof entry.source === "string" ? entry.source : "";
		const span = resolveSpan(claim, ctx.rawPrompt);
		if (span !== undefined) {
			intent.push({ id, answer, source: span });
			continue;
		}
		// No prompt span: only acceptable when the answer explicitly attributes
		// the claim to a non-user origin (INT-10's provenance question).
		if (NON_USER_PROVENANCE[claim.trim().toLowerCase()] === true) {
			intent.push({ id, answer, source: claim.trim() });
			continue;
		}
		errors.push(`${where}: source is not verbatim in the prompt: ${JSON.stringify(claim)}`);
	}
	if (intent.length === 0) errors.push("analyze: at least one intent answer is required");
	return { parts, intent };
}

function validateVerify(raw: unknown, ctx: ValidationContext, errors: string[]): VerifyResult | undefined {
	if (!isRecord(raw)) {
		errors.push("verify: result must be a JSON object");
		return undefined;
	}
	const coverage = raw.meaning_coverage;
	let meaningCoverage = 0;
	if (typeof coverage !== "number" || !Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
		errors.push('verify: "meaning_coverage" must be a number in [0, 1]');
	} else {
		meaningCoverage = coverage;
	}
	const problems: VerifyProblem[] = [];
	for (const [index, entry] of readArray(raw, "problems", "verify", errors).entries()) {
		const where = `verify: problems[${index}]`;
		// Observed shapes: an object, or a bare sentence. A bare sentence is a
		// real finding in a looser wrapper, so keep it under an unspecified type
		// rather than failing an otherwise valid verification.
		if (typeof entry === "string") {
			if (entry.trim().length > 0) problems.push({ type: "unspecified", message: entry.trim() });
			continue;
		}
		if (!isRecord(entry)) {
			errors.push(`${where} must be an object or a string`);
			continue;
		}
		const message = typeof entry.message === "string" && entry.message.trim().length > 0 ? entry.message : undefined;
		if (message === undefined) {
			errors.push(`${where}: "message" must be a non-empty string`);
			continue;
		}
		const type = typeof entry.type === "string" && entry.type.trim().length > 0 ? entry.type.trim() : "unspecified";
		// A problem may quote the paraphrase (model text) rather than the prompt,
		// so an unresolvable span is dropped rather than failing verification.
		const claim = typeof entry.source === "string" ? entry.source : undefined;
		const span = claim === undefined ? undefined : resolveSpan(claim, ctx.rawPrompt);
		problems.push(span === undefined ? { type, message } : { type, message, source: span });
	}
	return {
		category_match: readBoolean(raw, "category_match", errors),
		subcategory_match: readBoolean(raw, "subcategory_match", errors),
		meaning_coverage: meaningCoverage,
		invented_meaning_count: readCount(raw, "invented_meaning_count", errors),
		lost_meaning_count: readCount(raw, "lost_meaning_count", errors),
		coherent: readBoolean(raw, "coherent", errors),
		problems,
	};
}

/**
 * `detect_context` is validated by the detector's own parser, which is the
 * single definition of a well-formed `ContextDetection` (verbatim spans, known
 * sources, known weights). The stage runner has already stripped the fence and
 * parsed the JSON, so the value is re-serialized rather than re-implemented.
 */
function validateDetectContext(raw: unknown, ctx: ValidationContext, errors: string[]): ContextDetection | undefined {
	try {
		return parseContextDetection(JSON.stringify(raw), ctx.rawPrompt);
	} catch (error) {
		errors.push(`detect_context: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/**
 * Problem type for material references the retrieval ladder could not bind.
 * A run that ends here still delivers an analysis; the gap is reported, never
 * fatal, so the Verification tab can show which words were read unbound.
 */
export const UNRESOLVED_REFERENCE_PROBLEM = "unresolved_reference";

/**
 * Validate one stage's parsed JSON result.
 *
 * @returns `{ ok: true, value }` with a normalized result object, or
 * `{ ok: false, errors }` listing every violation found.
 */
export function validateStage(stage: Stage, raw: unknown, ctx: ValidationContext): ValidationOutcome {
	const errors: string[] = [];
	const value =
		stage === "detect_context"
			? validateDetectContext(raw, ctx, errors)
			: stage === "paraphrase"
				? validateParaphrase(raw, ctx, errors)
				: stage === "categorize"
					? validateCategorize(raw, ctx, errors)
					: stage === "analyze"
						? validateAnalyze(raw, ctx, errors)
						: stage === "verify"
							? validateVerify(raw, ctx, errors)
							: // `resolve_context` runs retrieval, not a model call: it has no
								// model result to validate and must never reach this function.
								undefined;
	if (value === undefined || errors.length > 0) {
		return { ok: false, errors: errors.length > 0 ? errors : [`${stage}: result could not be validated`] };
	}
	return { ok: true, value };
}
