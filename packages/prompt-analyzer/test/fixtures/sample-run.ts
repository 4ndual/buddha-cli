/**
 * A complete, realistic `AnalysisEvent` sequence for one run, used to drive
 * the browser deterministically through `window.__analyzer.applyEvent`.
 */
import type { AnalysisEvent, PromptAnalysis } from "../../src/contracts";
import { MIXED_PROMPT, PART_A, PART_B } from "./prompts";

export const SAMPLE_RUN_ID = "0199c0de-1234-7000-8000-abcdefabcdef";
export const SAMPLE_PROMPT_HASH = "a1b2c3d4e5f6";

export const SAMPLE_ANALYSIS: PromptAnalysis = {
	promptHash: SAMPLE_PROMPT_HASH,
	rawPrompt: MIXED_PROMPT,
	paraphrase: "Build a login page with email and password fields, and thanks for the fast turnaround.",
	parts: [
		{
			source: PART_A,
			paraphrase: "Build a login page with email and password fields.",
			categories: ["DIRECT"],
			subcategories: ["build_request"],
			tags: ["auth"],
		},
		{
			source: PART_B,
			paraphrase: "Thanks for the fast turnaround on the last one.",
			categories: ["SOCIALIZE"],
			subcategories: ["thanks"],
			tags: ["gratitude"],
		},
	],
	intent: [
		{ id: "INT-01", answer: "Asked for a login page and thanked the team.", source: PART_A },
		{ id: "INT-10", answer: "Every claim came from the user.", source: PART_B },
	],
	comparison: {
		categoryMatch: true,
		subcategoryMatch: true,
		meaningCoverage: 1,
		inventedMeaningCount: 0,
		lostMeaningCount: 0,
		coherent: true,
		problems: [],
	},
};

/** run_started -> paraphrase started/delta/completed -> ... -> run_verified. */
export const SAMPLE_RUN_EVENTS: AnalysisEvent[] = [
	{ type: "run_started", runId: SAMPLE_RUN_ID, promptHash: SAMPLE_PROMPT_HASH },
	{ type: "stage_started", runId: SAMPLE_RUN_ID, stage: "paraphrase" },
	{ type: "stage_delta", runId: SAMPLE_RUN_ID, stage: "paraphrase", text: '{"paraphrase":"Build a login page' },
	{ type: "stage_completed", runId: SAMPLE_RUN_ID, stage: "paraphrase", result: {} },
	{ type: "stage_started", runId: SAMPLE_RUN_ID, stage: "categorize" },
	{ type: "stage_completed", runId: SAMPLE_RUN_ID, stage: "categorize", result: {} },
	{ type: "stage_started", runId: SAMPLE_RUN_ID, stage: "analyze" },
	{ type: "stage_completed", runId: SAMPLE_RUN_ID, stage: "analyze", result: {} },
	{ type: "stage_started", runId: SAMPLE_RUN_ID, stage: "verify" },
	{ type: "stage_completed", runId: SAMPLE_RUN_ID, stage: "verify", result: {} },
	{ type: "run_verified", runId: SAMPLE_RUN_ID, result: SAMPLE_ANALYSIS },
];
