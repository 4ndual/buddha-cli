/**
 * Pipeline behavior: event order, real wave-1 concurrency, wave gating,
 * cancellation, failure handling, and faithful assembly of verification
 * findings into the final `PromptAnalysis`.
 *
 * Only the model boundary (`StageCall`) is stubbed; everything under test is
 * the real `runPipeline`.
 */
import { describe, expect, it } from "bun:test";
import type { AnalysisEvent, AnalysisRequest, PromptAnalysis, Stage } from "../src/contracts";
import { runPipeline } from "../src/pipeline";
import { createFixtureStageCall, type StageCallLogEntry, type StageSpec } from "./fixtures/fake-stage-call";
import { MIXED_PROMPT, PART_A, PART_B } from "./fixtures/prompts";
import { createRecordingLogger } from "./fixtures/recording-logger";
import { analyzeResponse, categorizeResponse, paraphraseResponse, verifyResponse } from "./fixtures/stage-responses";

/** Valid two-part fixture responses for every stage, DIRECT + SOCIALIZE. */
function happySpecs(overrides: Partial<Record<Stage, StageSpec>> = {}): Partial<Record<Stage, StageSpec>> {
	return {
		paraphrase: {
			json: paraphraseResponse([
				{ source: PART_A, paraphrase: "Build a login page with email and password fields." },
				{ source: PART_B, paraphrase: "Thanks for the fast turnaround on the last one." },
			]),
		},
		categorize: {
			json: categorizeResponse([
				{ text: PART_A, categories: ["DIRECT"] },
				{ text: PART_B, categories: ["SOCIALIZE"] },
			]),
		},
		analyze: {
			json: analyzeResponse(
				[
					{ text: PART_A, subcategories: ["build_request"], tags: ["auth"] },
					{ text: PART_B, subcategories: ["thanks"], tags: ["gratitude"] },
				],
				[
					{ id: "INT-01", answer: "Asked for a login page and thanked the team.", source: PART_A },
					{ id: "INT-10", answer: "Every claim came from the user.", source: PART_B },
				],
			),
		},
		verify: { json: verifyResponse({}) },
		...overrides,
	};
}

function request(runId = "run-1", rawPrompt = MIXED_PROMPT): AnalysisRequest {
	return { runId, promptHash: "hash01234567", rawPrompt };
}

async function collect(events: AsyncIterable<AnalysisEvent>): Promise<AnalysisEvent[]> {
	const out: AnalysisEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

function verifiedResult(events: AnalysisEvent[]): PromptAnalysis {
	const verified = events.find(event => event.type === "run_verified");
	if (verified?.type !== "run_verified") throw new Error(`no run_verified event in: ${events.map(e => e.type).join(", ")}`);
	return verified.result;
}

async function runHappyPath(overrides: Partial<Record<Stage, StageSpec>> = {}): Promise<{
	events: AnalysisEvent[];
	log: StageCallLogEntry[];
}> {
	const { call, log } = createFixtureStageCall(happySpecs(overrides));
	const events = await collect(
		runPipeline(request(), { call, log: createRecordingLogger(), signal: new AbortController().signal }),
	);
	return { events, log };
}

describe("runPipeline", () => {
	it("case 3: emits run_started, then per-stage started/delta/completed, then run_verified in order", async () => {
		const { events } = await runHappyPath({
			paraphrase: { ...happySpecs().paraphrase, chunks: ['{"paraphrase":', '"..."}'] },
		});

		const at = (predicate: (event: AnalysisEvent) => boolean): number => events.findIndex(predicate);
		const paraphraseStarted = at(e => e.type === "stage_started" && e.stage === "paraphrase");
		const paraphraseDelta = at(e => e.type === "stage_delta" && e.stage === "paraphrase");
		const paraphraseDone = at(e => e.type === "stage_completed" && e.stage === "paraphrase");
		const categorizeDone = at(e => e.type === "stage_completed" && e.stage === "categorize");
		const analyzeStarted = at(e => e.type === "stage_started" && e.stage === "analyze");
		const analyzeDone = at(e => e.type === "stage_completed" && e.stage === "analyze");
		const verifyStarted = at(e => e.type === "stage_started" && e.stage === "verify");
		const verifyDone = at(e => e.type === "stage_completed" && e.stage === "verify");

		expect(events[0]).toEqual({ type: "run_started", runId: "run-1", promptHash: "hash01234567" });
		// Per stage: started -> delta(s) -> completed, never out of order.
		expect(paraphraseStarted).toBeGreaterThan(-1);
		expect(paraphraseDelta).toBeGreaterThan(paraphraseStarted);
		expect(paraphraseDone).toBeGreaterThan(paraphraseDelta);
		// Wave gating is visible in the stream, not just in timing.
		expect(analyzeStarted).toBeGreaterThan(paraphraseDone);
		expect(analyzeStarted).toBeGreaterThan(categorizeDone);
		expect(verifyStarted).toBeGreaterThan(analyzeDone);
		expect(events.at(-1)?.type).toBe("run_verified");
		expect(verifyDone).toBe(events.length - 2);
		expect(events.filter(e => e.type === "stage_failed")).toHaveLength(0);
	});

	it("case 4: runs the two wave-1 calls concurrently, with genuinely overlapping execution windows", async () => {
		const base = happySpecs();
		const { log } = await runHappyPath({
			paraphrase: { ...base.paraphrase, delayMs: 150 },
			categorize: { ...base.categorize, delayMs: 150 },
		});

		const paraphrase = log.find(entry => entry.stage === "paraphrase");
		const categorize = log.find(entry => entry.stage === "categorize");
		if (!paraphrase || !categorize) throw new Error("wave 1 did not record both calls");

		const overlapStart = Math.max(paraphrase.startedAt, categorize.startedAt);
		const overlapEnd = Math.min(paraphrase.finishedAt, categorize.finishedAt);
		// Sequential execution would put one call's start after the other's
		// finish, making this window negative.
		expect(overlapEnd - overlapStart).toBeGreaterThan(100);
		// Both waited ~150ms yet the pair finished in ~150ms, not ~300ms.
		const wallClock = Math.max(paraphrase.finishedAt, categorize.finishedAt) - overlapStart;
		expect(wallClock).toBeLessThan(280);
	});

	it("case 5: starts analyze only after both wave-1 stages validate, and verify only after analyze", async () => {
		const base = happySpecs();
		const { log } = await runHappyPath({
			paraphrase: { ...base.paraphrase, delayMs: 40 },
			categorize: { ...base.categorize, delayMs: 20 },
			analyze: { ...base.analyze, delayMs: 20 },
			verify: { ...base.verify, delayMs: 10 },
		});

		const entry = (stage: Stage): { startedAt: number; finishedAt: number } => {
			const found = log.find(item => item.stage === stage);
			if (!found) throw new Error(`stage ${stage} never ran`);
			return found;
		};
		const paraphrase = entry("paraphrase");
		const categorize = entry("categorize");
		const analyze = entry("analyze");
		const verify = entry("verify");

		expect(analyze.startedAt).toBeGreaterThanOrEqual(paraphrase.finishedAt);
		expect(analyze.startedAt).toBeGreaterThanOrEqual(categorize.finishedAt);
		expect(verify.startedAt).toBeGreaterThanOrEqual(analyze.finishedAt);
	});

	it("case 7: an aborted signal stops generation and ends the run with run_cancelled", async () => {
		const base = happySpecs();
		const { call, log } = createFixtureStageCall({
			paraphrase: { ...base.paraphrase, delayMs: 500 },
			categorize: { ...base.categorize, delayMs: 500 },
			analyze: base.analyze,
			verify: base.verify,
		});
		const controller = new AbortController();

		const events: AnalysisEvent[] = [];
		for await (const event of runPipeline(request(), {
			call,
			log: createRecordingLogger(),
			signal: controller.signal,
		})) {
			events.push(event);
			if (event.type === "stage_started" && event.stage === "paraphrase") controller.abort();
		}

		expect(events.at(-1)).toEqual({ type: "run_cancelled", runId: "run-1" });
		expect(events.filter(e => e.type === "run_verified")).toHaveLength(0);
		// Generation stopped: neither wave-1 call ran to completion, and wave 2
		// and wave 3 never started at all.
		expect(log).toHaveLength(0);
		expect(events.some(e => e.type === "stage_started" && (e.stage === "analyze" || e.stage === "verify"))).toBe(false);
	});

	it("case 8: malformed model JSON yields stage_failed without crashing, and a retry still succeeds", async () => {
		const { call } = createFixtureStageCall(happySpecs({ paraphrase: { malformed: '{"paraphrase": "unterminated' } }));
		const failedEvents = await collect(
			runPipeline(request("run-broken"), {
				call,
				log: createRecordingLogger(),
				signal: new AbortController().signal,
			}),
		);

		const failure = failedEvents.find(event => event.type === "stage_failed");
		if (failure?.type !== "stage_failed") throw new Error("expected a stage_failed event");
		expect(failure.stage).toBe("paraphrase");
		expect(failure.error).toMatch(/JSON/i);
		expect(failedEvents.filter(e => e.type === "run_verified")).toHaveLength(0);
		// The failed stage ends the run before wave 2 — no half-analyzed output.
		expect(failedEvents.some(e => e.type === "stage_started" && e.stage === "analyze")).toBe(false);

		// Retry: the same code path immediately produces a full result again.
		const { events: retryEvents } = await runHappyPath();
		expect(retryEvents.at(-1)?.type).toBe("run_verified");
		expect(verifiedResult(retryEvents).parts).toHaveLength(2);
	});

	it("case 11: a lost constraint reported by verification reaches the assembled result", async () => {
		const { events } = await runHappyPath({
			verify: {
				json: verifyResponse({
					lost_meaning_count: 1,
					meaning_coverage: 0.5,
					coherent: false,
					problems: [
						{
							type: "lost_constraint",
							message: "The paraphrase drops the requirement for email and password fields.",
							source: PART_A,
						},
					],
				}),
			},
		});

		const { comparison } = verifiedResult(events);
		expect(comparison.lostMeaningCount).toBe(1);
		expect(comparison.coherent).toBe(false);
		expect(comparison.meaningCoverage).toBe(0.5);
		expect(comparison.problems).toEqual([
			{
				type: "lost_constraint",
				message: "The paraphrase drops the requirement for email and password fields.",
				source: PART_A,
			},
		]);
	});

	it("case 12: invented meaning reported by verification reaches the assembled result", async () => {
		const { events } = await runHappyPath({
			verify: {
				json: verifyResponse({
					invented_meaning_count: 1,
					coherent: false,
					problems: [
						{ type: "invented_meaning", message: "The paraphrase adds OAuth, which the prompt never mentions." },
					],
				}),
			},
		});

		const { comparison } = verifiedResult(events);
		expect(comparison.inventedMeaningCount).toBe(1);
		expect(comparison.lostMeaningCount).toBe(0);
		expect(comparison.problems).toEqual([
			{ type: "invented_meaning", message: "The paraphrase adds OAuth, which the prompt never mentions." },
		]);
	});

	it("case 13: a mixed-category prompt produces different categories on different parts", async () => {
		const { events } = await runHappyPath();

		const { parts } = verifiedResult(events);
		expect(parts.map(part => part.source)).toEqual([PART_A, PART_B]);
		expect(parts[0]?.categories).toEqual(["DIRECT"]);
		expect(parts[1]?.categories).toEqual(["SOCIALIZE"]);
		expect(parts[0]?.subcategories).toEqual(["build_request"]);
		expect(parts[1]?.subcategories).toEqual(["thanks"]);
		// One category forced over the whole prompt would collapse this set to 1.
		expect(new Set(parts.flatMap(part => part.categories)).size).toBe(2);
	});

	it("required intents: re-asks analyze once for a missing INT-10, then records missing_required_intent", async () => {
		// Both analyze responses omit INT-10, which the registry marks always-on.
		const withoutRequired = analyzeResponse(
			[
				{ text: PART_A, subcategories: ["build_request"], tags: ["auth"] },
				{ text: PART_B, subcategories: ["thanks"], tags: ["gratitude"] },
			],
			[{ id: "INT-01", answer: "Asked for a login page and thanked the team.", source: PART_A }],
		);
		const { call, log } = createFixtureStageCall(
			happySpecs({ analyze: { jsonSequence: [withoutRequired, withoutRequired] } }),
		);
		const events = await collect(
			runPipeline(request(), { call, log: createRecordingLogger(), signal: new AbortController().signal }),
		);

		// Exactly one re-ask: bounded, and it names what is missing.
		const analyzeCalls = log.filter(entry => entry.stage === "analyze");
		expect(analyzeCalls).toHaveLength(2);
		expect(analyzeCalls[1]?.user).toContain("INT-10");
		// A stubborn model degrades the run, it never kills it.
		const result = verifiedResult(events);
		expect(result.intent.map(answer => answer.id)).toEqual(["INT-01"]);
		expect(result.comparison.problems.some(problem => problem.type === "missing_required_intent")).toBe(true);
		// The affected stage reports it too, so the UI can show it in place.
		const analyzeCompleted = events.filter(event => event.type === "stage_completed" && event.stage === "analyze");
		expect(analyzeCompleted).toHaveLength(1);
	});
});
