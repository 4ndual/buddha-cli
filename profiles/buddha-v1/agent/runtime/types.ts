/**
 * Buddha mode shared contracts.
 *
 * Buddha is the root agent: a 5-line system prompt plus exactly one tool
 * (`siddhi`). All real work happens in hidden ordinary OMP subagents routed by
 * the Luna router. Nothing in this file may import provider-facing prompt or
 * tool inventory helpers — it is the contract boundary between the four
 * Buddha-mode slices (session wiring, siddhi tool, router, workers).
 */

/** Lifecycle of a delegated Buddha job, as visible to Buddha. */
export type SiddhiStatus = "working" | "done" | "blocked";

/** The only value Buddha's model context ever receives from a `siddhi` call. */
export interface SiddhiResult {
	status: SiddhiStatus;
	/** Control-plane summary. Hard cap: SIDDHI_SUMMARY_MAX_CHARS. Never raw worker output. */
	summary: string;
	jobId: string;
}

/** Max characters of `SiddhiResult.summary` that may reach Buddha. */
export const SIDDHI_SUMMARY_MAX_CHARS = 700;

/** Logical worker mode. All modes reuse the ordinary OMP subagent implementation. */
export type WorkerMode = "executor" | "verifier" | "repairer" | "integrator";

/** Compact durable job record. Detailed state lives in artifacts/session storage. */
export interface SiddhiJob {
	id: string;
	status: SiddhiStatus;
	/** Session entry id of the user request that opened this job. */
	userRequestRef: string;
	outcome: string;
	constraints: string[];
	doneWhen: string[];
	workerIds: string[];
	artifactRefs: string[];
	evidenceRefs: string[];
	assumptions: string[];
	lastSummary: string;
}

/** One worker turn's compact outcome — what Luna is allowed to inspect. */
export interface WorkerOutcome {
	workerId: string;
	mode: WorkerMode;
	/** Truncated worker report for routing decisions. Never full transcript. */
	digest: string;
	artifactRefs: string[];
	failed: boolean;
	/** Artifact id holding the worker's full user-facing answer, when it produced one. */
	answerArtifactId?: string;
	/** The worker's full final text, held in memory only for promotion to the user. */
	answerText?: string;
}

/** Validated runtime action returned by the Luna router. */
export type RouterAction =
	| { action: "start"; workerType: string; instruction: string; doneWhen: string[] }
	| { action: "resume" | "steer" | "verify" | "repair"; workerId: string; instruction: string }
	| { action: "finish"; summary: string; userResultRef: string }
	| { action: "blocked"; reason: string };

/** Everything Luna is given. Deliberately compact — no schemas, no transcripts. */
export interface RouterInput {
	instruction: string;
	job: SiddhiJob;
	/** name + one-line description per available worker capability. */
	capabilities: readonly { name: string; description: string }[];
	outcomes: readonly WorkerOutcome[];
	/** Live/parked workers from earlier jobs in this session that may be resumed instead of starting fresh. */
	readonly reusableWorkers?: readonly { workerId: string; mode: WorkerMode; jobId: string; digest: string }[];
}

/** JSONL `custom` entry customType journaling SiddhiJob transitions. */
export const SIDDHI_JOB_CUSTOM_TYPE = "siddhi_job";

/** `custom_message` customType for the user-visible worker answer. Excluded from LLM context. */
export const SIDDHI_RESULT_MESSAGE_TYPE = "siddhi-result";

/** Clamp any control-plane string to Buddha's summary budget. */
export function clampSummary(text: string, max: number = SIDDHI_SUMMARY_MAX_CHARS): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
