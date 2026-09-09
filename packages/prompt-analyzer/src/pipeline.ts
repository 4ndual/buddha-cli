/**
 * The three-wave analysis pipeline.
 *
 * Wave 1 runs `paraphrase` and `categorize` genuinely concurrently, wave 2
 * runs `analyze` over their merged output, wave 3 runs `verify` over
 * everything. `PromptAnalysis` is assembled here, by application code — no
 * single model call produces it.
 *
 * Contract details that matter:
 * - Deltas stream out live while a stage is still generating, but JSON is
 *   parsed exactly once, at stage completion. Never per token.
 * - A stage result becomes pipeline state only after `validateStage` accepts
 *   it. A parse or validation failure yields `stage_failed` and ends the run;
 *   the generator never throws and never yields partial structured data.
 * - Wave 2 receives only the subcategories and intent questions its detected
 *   categories activate, never the whole registry.
 */

import type {
	AnalysisEvent,
	AnalysisRequest,
	AnalyzedPart,
	Comparison,
	IntentAnswer,
	Problem,
	PromptAnalysis,
	Stage,
} from "./contracts";
import { activeQuestionIds, INTENT_QUESTIONS, SUBCATEGORIES, isCategory } from "./registry";
import { ANALYZE_SYSTEM, CATEGORIZE_SYSTEM, PARAPHRASE_SYSTEM, VERIFY_SYSTEM } from "./stage-prompts";
import type { AnalyzeResult, CategorizeResult, ParaphraseResult, VerifyResult } from "./validate";
import { missingRequiredIntentIds, REQUIRED_INTENT_IDS, validateStage } from "./validate";

/**
 * One model call. `onDelta` receives incremental assistant text; the resolved
 * string is the stage's complete raw response.
 */
export type StageCall = (
	stage: Stage,
	system: string,
	user: string,
	onDelta: (text: string) => void,
	signal: AbortSignal,
) => Promise<string>;

/** Stage transition sink (the terminal logger implements this shape). */
export interface StageLogger {
	stage(stage: Stage, phase: "started" | "completed" | "failed", info?: { ms?: number; error?: string }): void;
}

export interface PipelineDeps {
	call: StageCall;
	log: StageLogger;
	signal: AbortSignal;
}

type StageOutcome =
	| { stage: Stage; status: "ok"; value: unknown }
	| { stage: Stage; status: "failed"; error: string }
	| { stage: Stage; status: "cancelled" };

interface StageTask {
	stage: Stage;
	system: string;
	user: string;
	/** Categories that scope subcategory validation (wave 2 only). */
	categories?: string[];
	/**
	 * Bounded second ask for the same stage. Called once with the validated
	 * result; returning a follow-up triggers exactly ONE more model call (same
	 * stage, same instruction, new user message) whose validated result is
	 * merged in. A follow-up that fails to parse, fails validation or errors
	 * keeps the first result — the extra ask can improve a result, never break
	 * one. The stage still reports a single started/completed pair.
	 */
	followUp?: (value: unknown) => { user: string; merge: (followUpValue: unknown) => unknown } | undefined;
}

/**
 * Single-producer/single-consumer async queue. Wave 1's two concurrent stages
 * push events as they happen; the generator drains them in arrival order, so a
 * delta from one stage is not held hostage by the other stage's latency.
 */
class EventQueue {
	#items: AnalysisEvent[] = [];
	#wake: (() => void) | undefined;
	#closed = false;

	push(event: AnalysisEvent): void {
		this.#items.push(event);
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	close(): void {
		this.#closed = true;
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	async *drain(): AsyncGenerator<AnalysisEvent> {
		while (true) {
			while (this.#items.length > 0) {
				const next = this.#items.shift();
				if (next !== undefined) yield next;
			}
			if (this.#closed) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#wake = resolve;
			await promise;
		}
	}
}

/** Strip an optional markdown fence, then parse strictly. No partial repair. */
function parseStageJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
	let text = raw.trim();
	if (text.startsWith("```")) {
		const firstBreak = text.indexOf("\n");
		const closing = text.lastIndexOf("```");
		if (firstBreak !== -1 && closing > firstBreak) text = text.slice(firstBreak + 1, closing).trim();
	}
	if (text.length === 0) return { ok: false, error: "model returned no text" };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: `response is not valid JSON: ${error instanceof Error ? error.message : error}` };
	}
}

async function runStageTask(
	task: StageTask,
	request: AnalysisRequest,
	deps: PipelineDeps,
	queue: EventQueue,
): Promise<StageOutcome> {
	const { runId, rawPrompt } = request;
	const { stage } = task;
	const startedAt = Date.now();
	deps.log.stage(stage, "started");
	queue.push({ type: "stage_started", runId, stage });

	const fail = (error: string): StageOutcome => {
		deps.log.stage(stage, "failed", { ms: Date.now() - startedAt, error });
		queue.push({ type: "stage_failed", runId, stage, error });
		return { stage, status: "failed", error };
	};

	let raw: string;
	try {
		raw = await deps.call(
			stage,
			task.system,
			task.user,
			text => queue.push({ type: "stage_delta", runId, stage, text }),
			deps.signal,
		);
	} catch (error) {
		if (deps.signal.aborted) return { stage, status: "cancelled" };
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (deps.signal.aborted) return { stage, status: "cancelled" };

	const parsed = parseStageJson(raw);
	if (!parsed.ok) return fail(parsed.error);
	const context = { rawPrompt, categories: task.categories };
	const validated = validateStage(stage, parsed.value, context);
	if (!validated.ok) return fail(validated.errors.join("; "));

	let value = validated.value;
	const followUp = deps.signal.aborted ? undefined : task.followUp?.(value);
	if (followUp !== undefined) {
		try {
			const followUpRaw = await deps.call(
				stage,
				task.system,
				followUp.user,
				text => queue.push({ type: "stage_delta", runId, stage, text }),
				deps.signal,
			);
			if (deps.signal.aborted) return { stage, status: "cancelled" };
			const followUpParsed = parseStageJson(followUpRaw);
			if (followUpParsed.ok) {
				const followUpValidated = validateStage(stage, followUpParsed.value, context);
				if (followUpValidated.ok) value = followUp.merge(followUpValidated.value);
			}
		} catch {
			// The follow-up is best-effort: a provider error keeps the first
			// result, and an abort ends the run.
			if (deps.signal.aborted) return { stage, status: "cancelled" };
		}
	}

	deps.log.stage(stage, "completed", { ms: Date.now() - startedAt });
	queue.push({ type: "stage_completed", runId, stage, result: value });
	return { stage, status: "ok", value };
}

/**
 * Run one wave. Tasks start together and their events interleave; the wave's
 * outcomes are the generator's return value.
 */
async function* runWave(
	tasks: StageTask[],
	request: AnalysisRequest,
	deps: PipelineDeps,
): AsyncGenerator<AnalysisEvent, StageOutcome[]> {
	const queue = new EventQueue();
	const settled = Promise.all(tasks.map(task => runStageTask(task, request, deps, queue)));
	void settled.then(
		() => queue.close(),
		() => queue.close(),
	);
	for await (const event of queue.drain()) yield event;
	return await settled;
}

function promptBlock(label: string, body: string): string {
	return `${label}:\n<<<\n${body}\n>>>`;
}

/** Wave 2 context: detected parts, plus only the registry slices they activate. */
function analyzeUserMessage(
	rawPrompt: string,
	paraphrase: ParaphraseResult,
	categorize: CategorizeResult,
): { user: string; categories: string[] } {
	const paraphraseBySource = paraphraseByOverlap(
		rawPrompt,
		paraphrase,
		categorize.parts.map(part => part.text),
	);

	const detected: string[] = [];
	for (const part of categorize.parts) {
		for (const category of part.categories) {
			if (isCategory(category) && !detected.includes(category)) detected.push(category);
		}
	}

	const allowedSubcategories: Record<string, readonly string[]> = {};
	for (const category of detected) {
		if (isCategory(category)) allowedSubcategories[category] = SUBCATEGORIES[category];
	}

	// INT-01 and INT-10 are "always" questions: the registry activates them for
	// every run, so the user message states plainly that they MUST be answered
	// while the rest are optional. ANALYZE_SYSTEM stays verbatim.
	const activatedQuestions = activeQuestionIds(detected).map(id => ({
		id,
		question: INTENT_QUESTIONS[id]?.question ?? "",
		required: REQUIRED_INTENT_IDS.includes(id),
	}));

	const payload = {
		parts: categorize.parts.map(part => ({
			text: part.text,
			paraphrase: paraphraseBySource[part.text] ?? "",
			categories: part.categories,
		})),
		allowed_subcategories: allowedSubcategories,
		activated_intent_questions: activatedQuestions,
		required_intent_questions: REQUIRED_INTENT_IDS,
	};

	return {
		categories: detected,
		user: [
			promptBlock("RAW PROMPT", rawPrompt),
			"",
			`REQUIRED: answer ${REQUIRED_INTENT_IDS.join(" and ")}. Every other activated question is optional.`,
			"",
			`ANALYSIS CONTEXT:\n${JSON.stringify(payload, null, 2)}`,
		].join("\n"),
	};
}

/**
 * Re-ask context: the analysis already produced, plus exactly which required
 * question ids are still unanswered. One extra call at most, per run.
 */
function reaskUserMessage(rawPrompt: string, analyze: AnalyzeResult, missing: readonly string[]): string {
	const questions = missing.map(id => ({ id, question: INTENT_QUESTIONS[id]?.question ?? "" }));
	return [
		promptBlock("RAW PROMPT", rawPrompt),
		"",
		`MISSING REQUIRED ANSWERS: ${missing.join(", ")}. These must be answered.`,
		"",
		`UNANSWERED QUESTIONS:\n${JSON.stringify(questions, null, 2)}`,
		"",
		`ANALYSIS SO FAR:\n${JSON.stringify({ parts: analyze.parts, intent: analyze.intent }, null, 2)}`,
	].join("\n");
}

/**
 * Fold a re-ask's answers for the previously missing ids into the first
 * result. The first attempt stays authoritative for parts and for every id it
 * already answered; only the named gaps are filled.
 */
function mergeIntentAnswers(first: AnalyzeResult, followUp: AnalyzeResult, missing: readonly string[]): AnalyzeResult {
	const intent = [...first.intent];
	for (const answer of followUp.intent) {
		if (!missing.includes(answer.id)) continue;
		if (intent.some(existing => existing.id === answer.id)) continue;
		intent.push(answer);
	}
	return { parts: first.parts, intent };
}

/** Wave 3 context: the raw prompt, the paraphrase, the assembled parts, the intent answers. */
function verifyUserMessage(rawPrompt: string, paraphrase: string, parts: AnalyzedPart[], analyze: AnalyzeResult): string {
	const payload = { paraphrase, parts, intent: analyze.intent };
	return `${promptBlock("RAW PROMPT", rawPrompt)}\n\nPROPOSED ANALYSIS:\n${JSON.stringify(payload, null, 2)}`;
}

/** Half-open character range of a span inside the raw prompt. */
interface SpanRange {
	start: number;
	end: number;
}

function locateSpan(span: string, rawPrompt: string): SpanRange | undefined {
	const start = rawPrompt.indexOf(span);
	return start === -1 ? undefined : { start, end: start + span.length };
}

function sharedLength(a: SpanRange, b: SpanRange): number {
	return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Best paraphrase text for each target span.
 *
 * The paraphrase and categorize stages are independent calls, so their splits
 * routinely disagree — one paraphrase part often covers two categorized parts.
 * Exact text wins; otherwise the paraphrase part sharing the most characters
 * with the target inside the raw prompt does.
 */
function paraphraseByOverlap(
	rawPrompt: string,
	paraphrase: ParaphraseResult,
	targets: readonly string[],
): Record<string, string> {
	const spans = paraphrase.parts.map(part => ({ part, range: locateSpan(part.source, rawPrompt) }));
	const byTarget: Record<string, string> = {};
	for (const target of targets) {
		const exact = paraphrase.parts.find(candidate => candidate.source === target)?.paraphrase;
		if (exact !== undefined) {
			byTarget[target] = exact;
			continue;
		}
		const range = locateSpan(target, rawPrompt);
		let best = 0;
		let text = "";
		if (range !== undefined) {
			for (const candidate of spans) {
				if (candidate.range === undefined) continue;
				const shared = sharedLength(range, candidate.range);
				if (shared > best) {
					best = shared;
					text = candidate.part.paraphrase;
				}
			}
		}
		byTarget[target] = text;
	}
	return byTarget;
}

/**
 * Merge the three stages' per-part views.
 *
 * The `categorize` split defines part identity, because the spec requires every
 * part to carry at least one category and only that stage produces categories.
 * The other two stages split independently — a paraphrase part routinely spans
 * two categorized parts — so their contributions are attached by character
 * overlap inside the raw prompt (exact text match first). Merging on string
 * equality alone produced category-less duplicate parts whenever the splits
 * disagreed.
 *
 * Folded subcategories are NOT filtered against the part's own categories: a
 * mismatch is exactly what the verify stage is asked to judge.
 */
function assembleParts(
	rawPrompt: string,
	paraphrase: ParaphraseResult,
	categorize: CategorizeResult,
	analyze: AnalyzeResult,
): AnalyzedPart[] {
	const paraphraseBySource = paraphraseByOverlap(
		rawPrompt,
		paraphrase,
		categorize.parts.map(part => part.text),
	);
	const analyzeSpans = analyze.parts.map(part => ({ part, range: locateSpan(part.text, rawPrompt) }));

	return categorize.parts.map(categorized => {
		const range = locateSpan(categorized.text, rawPrompt);

		const subcategories: string[] = [];
		const tags: string[] = [];
		for (const candidate of analyzeSpans) {
			const matches =
				candidate.part.text === categorized.text ||
				(range !== undefined && candidate.range !== undefined && sharedLength(range, candidate.range) > 0);
			if (!matches) continue;
			for (const subcategory of candidate.part.subcategories) {
				if (!subcategories.includes(subcategory)) subcategories.push(subcategory);
			}
			for (const tag of candidate.part.tags) {
				if (!tags.includes(tag)) tags.push(tag);
			}
		}

		return {
			source: categorized.text,
			paraphrase: paraphraseBySource[categorized.text] ?? "",
			categories: categorized.categories,
			subcategories,
			tags,
		};
	});
}

/**
 * Map the verify result onto `Comparison`, appending problems the pipeline
 * itself found (an unanswered required intent question) so they surface in the
 * same list the Verification tab renders.
 */
function assembleComparison(verify: VerifyResult, pipelineProblems: readonly Problem[]): Comparison {
	return {
		categoryMatch: verify.category_match,
		subcategoryMatch: verify.subcategory_match,
		meaningCoverage: verify.meaning_coverage,
		inventedMeaningCount: verify.invented_meaning_count,
		lostMeaningCount: verify.lost_meaning_count,
		coherent: verify.coherent,
		problems: [
			...verify.problems.map(problem =>
				problem.source === undefined
					? { type: problem.type, message: problem.message }
					: { type: problem.type, message: problem.message, source: problem.source },
			),
			...pipelineProblems,
		],
	};
}

/**
 * Run the full pipeline for one request.
 *
 * Yields, in order: `run_started`; wave 1's interleaved `stage_started` /
 * `stage_delta` / `stage_completed` for `paraphrase` and `categorize`; wave 2's
 * `analyze`; wave 3's `verify`; then `run_verified` with the assembled
 * analysis.
 *
 * The stream ALWAYS ends on a terminal event, so a consumer never has to infer
 * the end of a run from the iterable returning: a verified run ends with
 * `run_verified`, and an aborted signal or a failed stage (whose diagnostic is
 * the preceding `stage_failed`) ends with `run_cancelled`.
 */
export async function* runPipeline(request: AnalysisRequest, deps: PipelineDeps): AsyncIterable<AnalysisEvent> {
	const { runId, promptHash, rawPrompt } = request;
	yield { type: "run_started", runId, promptHash };
	if (deps.signal.aborted) {
		yield { type: "run_cancelled", runId };
		return;
	}

	const wave1 = yield* runWave(
		[
			{ stage: "paraphrase", system: PARAPHRASE_SYSTEM, user: promptBlock("PROMPT", rawPrompt) },
			{ stage: "categorize", system: CATEGORIZE_SYSTEM, user: promptBlock("PROMPT", rawPrompt) },
		],
		request,
		deps,
	);
	if (wave1.some(outcome => outcome.status === "cancelled") || deps.signal.aborted) {
		yield { type: "run_cancelled", runId };
		return;
	}
	if (wave1.some(outcome => outcome.status === "failed")) {
		yield { type: "run_cancelled", runId };
		return;
	}

	const paraphrase = wave1.find(outcome => outcome.stage === "paraphrase");
	const categorize = wave1.find(outcome => outcome.stage === "categorize");
	if (paraphrase?.status !== "ok" || categorize?.status !== "ok") {
		yield { type: "run_cancelled", runId };
		return;
	}
	const paraphraseResult = paraphrase.value as ParaphraseResult;
	const categorizeResult = categorize.value as CategorizeResult;

	const analyzeContext = analyzeUserMessage(rawPrompt, paraphraseResult, categorizeResult);
	const wave2 = yield* runWave(
		[
			{
				stage: "analyze",
				system: ANALYZE_SYSTEM,
				user: analyzeContext.user,
				categories: analyzeContext.categories,
				// "Always evaluated" (INT-01, INT-10) is enforced here: one
				// bounded re-ask naming exactly the unanswered ids, then the run
				// continues either way.
				followUp: value => {
					const first = value as AnalyzeResult;
					const missing = missingRequiredIntentIds(first.intent);
					if (missing.length === 0) return undefined;
					return {
						user: reaskUserMessage(rawPrompt, first, missing),
						merge: followUpValue => mergeIntentAnswers(first, followUpValue as AnalyzeResult, missing),
					};
				},
			},
		],
		request,
		deps,
	);
	const analyze = wave2[0];
	if (analyze === undefined || analyze.status === "cancelled" || deps.signal.aborted) {
		yield { type: "run_cancelled", runId };
		return;
	}
	if (analyze.status !== "ok") {
		yield { type: "run_cancelled", runId };
		return;
	}
	const analyzeResult = analyze.value as AnalyzeResult;
	// One assembly, used both as wave 3's subject and as the delivered result.
	const parts = assembleParts(rawPrompt, paraphraseResult, categorizeResult, analyzeResult);

	const wave3 = yield* runWave(
		[
			{
				stage: "verify",
				system: VERIFY_SYSTEM,
				user: verifyUserMessage(rawPrompt, paraphraseResult.paraphrase, parts, analyzeResult),
			},
		],
		request,
		deps,
	);
	const verify = wave3[0];
	if (verify === undefined || verify.status === "cancelled" || deps.signal.aborted) {
		yield { type: "run_cancelled", runId };
		return;
	}
	if (verify.status !== "ok") {
		yield { type: "run_cancelled", runId };
		return;
	}
	const verifyResult = verify.value as VerifyResult;

	const intent: IntentAnswer[] = analyzeResult.intent.map(answer => ({
		id: answer.id,
		answer: answer.answer,
		source: answer.source,
	}));
	// Still unanswered after the bounded re-ask: report it, never kill the run.
	const stillMissing = missingRequiredIntentIds(intent);
	const pipelineProblems: Problem[] =
		stillMissing.length === 0
			? []
			: [
					{
						type: "missing_required_intent",
						message: `The analysis stage left always-evaluated intent question(s) unanswered after one re-ask: ${stillMissing.join(", ")}.`,
					},
				];
	const result: PromptAnalysis = {
		promptHash,
		rawPrompt,
		paraphrase: paraphraseResult.paraphrase,
		parts,
		intent,
		comparison: assembleComparison(verifyResult, pipelineProblems),
	};
	yield { type: "run_verified", runId, result };
}
