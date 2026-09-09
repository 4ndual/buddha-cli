/**
 * Buddha live prompt analyzer — shared contracts.
 *
 * The backend assembles `PromptAnalysis` from four narrow model calls; no single
 * call produces it. Browser code sees ONLY `AnalysisEvent`; OMP protocol details
 * never cross this boundary.
 */

import type { ContextResolution, ResolvedReference } from "./context-contracts";

/**
 * Pipeline stage. Wave 0 = detect_context (concurrent with wave 1's paraphrase
 * + categorize), then resolve_context, wave 2 = analyze, wave 3 = verify.
 */
export type Stage = "detect_context" | "paraphrase" | "categorize" | "resolve_context" | "analyze" | "verify";

/** Hard ceiling on simultaneous model calls (spec: 2). */
export const MAX_CONCURRENT_CALLS = 2;

/** Normalized event stream delivered to the browser. */
export type AnalysisEvent =
	| { type: "run_started"; runId: string; promptHash: string }
	| { type: "stage_started"; runId: string; stage: Stage }
	| { type: "stage_delta"; runId: string; stage: Stage; text: string }
	| { type: "stage_completed"; runId: string; stage: Stage; result: unknown }
	| { type: "stage_failed"; runId: string; stage: Stage; error: string }
	| {
			type: "context_progress";
			runId: string;
			confidence: number;
			tier: number;
			retrieversLaunched: number;
			references: ResolvedReference[];
	  }
	| { type: "run_verified"; runId: string; result: PromptAnalysis }
	| { type: "run_stale"; runId: string }
	| { type: "run_cancelled"; runId: string };

/** One conversational turn, oldest-first, ending just before `rawPrompt`. */
export interface ConversationTurn {
	role: string;
	text: string;
}

/** A browser request to analyze one exact prompt. */
export interface AnalysisRequest {
	runId: string;
	promptHash: string;
	rawPrompt: string;
	/** Prior turns available for reference resolution. Omitted or empty when none. */
	turns?: readonly ConversationTurn[];
}

/** Final assembled analysis. Assembled by application code, never by one model call. */
export interface PromptAnalysis {
	promptHash: string;
	rawPrompt: string;
	paraphrase: string;
	parts: AnalyzedPart[];
	intent: IntentAnswer[];
	comparison: Comparison;
	context: ContextResolution;
}

export interface AnalyzedPart {
	source: string;
	paraphrase: string;
	categories: string[];
	subcategories: string[];
	tags: string[];
}

export interface IntentAnswer {
	id: string;
	answer: string;
	source: string;
}

export interface Comparison {
	categoryMatch: boolean;
	subcategoryMatch: boolean;
	meaningCoverage: number;
	inventedMeaningCount: number;
	lostMeaningCount: number;
	coherent: boolean;
	problems: Problem[];
}

export interface Problem {
	type: string;
	message: string;
	source?: string;
}

/** Transport seam. The RPC adapter is the only implementation for this MVP. */
export interface OmpTransport {
	start(): Promise<void>;
	analyze(request: AnalysisRequest): AsyncIterable<AnalysisEvent>;
	cancel(runId: string): Promise<void>;
	dispose(): Promise<void>;
}
