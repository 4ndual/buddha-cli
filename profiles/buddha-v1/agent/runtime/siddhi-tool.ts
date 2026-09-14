/**
 * `siddhi` — the only tool Buddha ever sees.
 *
 * Its schema and description are the entire tool surface in Buddha's model
 * context, so both stay minimal. Every call opens or resumes a job, then runs
 * a bounded Luna routing loop over hidden ordinary OMP workers. The worker's
 * full answer is promoted straight to the user transcript; the model only ever
 * receives `{status, summary, jobId}`.
 */

import { schemaType } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	SUBAGENT_WARNING_MISSING_YIELD,
	SUBAGENT_WARNING_NULL_YIELD,
	SUBAGENT_WARNING_SCHEMA_OVERRIDDEN,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { collectReusableWorkers, openOrResumeJob, saveJob } from "./jobs";
import { peakBuddhaTokens, peakLunaTokens, recordJobMetrics } from "./metrics";
import { promoteWorkerAnswer } from "./promote";
import { routeNext, WORKER_CAPABILITIES } from "./router";
import {
	clampSummary,
	SIDDHI_RESULT_MESSAGE_TYPE,
	type SiddhiJob,
	type SiddhiResult,
	type WorkerOutcome,
} from "./types";
import { runWorkerAction } from "./workers";

/** Hard ceiling on Luna routing rounds per `siddhi` call. */
const MAX_ROUTING_ITERATIONS = 12;
/** Wall-clock budget per `siddhi` call; exhaustion returns a resumable `working` result. */
const ROUTING_BUDGET_MS = 8 * 60 * 1000;

const siddhiSchema = schemaType({
	instruction: schemaType("string").describe(
		"natural language: outcome, constraints, done when; name a jobId to resume it",
	),
});

const SIDDHI_DESCRIPTION =
	"Delegate a request to hidden workers. `instruction` is natural language stating the outcome, any constraints, and when it is done. Naming an existing jobId resumes that job. The full result goes straight to the user; you get back only a short status summary.";

/** UI-only details; never part of the model-visible tool output. */
interface SiddhiToolDetails {
	jobId: string;
	status: SiddhiResult["status"];
	workerIds: string[];
	artifactRefs: string[];
	rounds: number;
}

/**
 * Build the `ToolSession` the router and worker runner operate on.
 *
 * `CustomTool.execute` only receives a read-only `CustomToolContext`, so the
 * live root session (full `SessionManager`, IRC relay) comes from the agent
 * registry — the pattern `commit/agentic/tools/analyze-file.ts` uses to build
 * a `ToolSession` inside a custom tool.
 */
export function buildToolSession(ctx: CustomToolContext): ToolSession | undefined {
	const registry = AgentRegistry.global();
	const current = registry.list().find(ref => ref.session?.sessionManager === ctx.sessionManager);
	const live = current?.session ?? registry.get(MAIN_AGENT_ID)?.session;
	if (!live) return undefined;
	return {
		cwd: ctx.sessionManager.getCwd(),
		// Hidden delegated workers never own the interactive surface.
		hasUI: false,
		suppressSpawnAdvisory: true,
		getSessionFile: () => ctx.sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getSessionId: () => ctx.sessionManager.getSessionId?.() ?? null,
		settings: ctx.settings ?? live.settings,
		modelRegistry: ctx.modelRegistry,
		fetch: ctx.fetch,
		localProtocolOptions: ctx.localProtocolOptions,
		sessionManager: live.sessionManager,
		agentRegistry: registry,
		getAgentId: () => current?.id ?? MAIN_AGENT_ID,
		getActiveModel: () => ctx.model,
	};
}

function mergeRefs(current: string[], incoming: readonly string[]): string[] {
	const merged = new Set(current);
	for (const ref of incoming) merged.add(ref);
	return [...merged];
}

/**
 * Executor banners prepended to a worker's raw output (executor.ts:691) when
 * the turn yielded nothing usable. Alone they are a non-answer: promoting one
 * would show the user a system warning in place of a result.
 */
const WORKER_WARNING_BANNERS: readonly string[] = [
	SUBAGENT_WARNING_NULL_YIELD,
	SUBAGENT_WARNING_MISSING_YIELD,
	SUBAGENT_WARNING_SCHEMA_OVERRIDDEN,
];

/** The worker's answer with those banners stripped; empty when the turn produced no answer at all. */
function answerWithoutBanners(text: string): string {
	let remaining = text;
	for (const banner of WORKER_WARNING_BANNERS) remaining = remaining.split(banner).join("");
	return remaining.trim();
}

/**
 * Buddha's stop signal for a settled job. Buddha never sees the answer, so
 * without an explicit "the user already has it" fact it keeps re-delegating
 * the same finished request. Naming the fact alone proved too weak in a real
 * run (three jobs for one question), so the sentence also states that the
 * delegation is closed. Pure delegation metadata — no worker content.
 */
const DELIVERED_SUMMARY =
	"Complete. The user has already received the full result in this conversation; it is not repeated here by design. Do not call siddhi again for this request — no further delegation is needed.";

/**
 * What the user has already been shown, read straight off the journal so it
 * survives the process boundary between print-mode turns.
 *
 * `deliveredThisTurn` is the load-bearing one: Buddha cannot see the answer,
 * so it re-delegates the same request within one user turn, and each retry
 * produces the same information in different words — textually distinct, so
 * content matching alone cannot stop it. One user request earns exactly one
 * delivered result; a *new* user turn (a follow-up) delivers again normally.
 */
function deliveryState(
	session: ToolSession,
	jobId: string,
): { contents: string[]; deliveredThisTurn: boolean; deliveredThisJob: boolean } {
	const contents: string[] = [];
	let deliveredThisTurn = false;
	let deliveredThisJob = false;
	for (const entry of session.sessionManager?.getBranch() ?? []) {
		if (entry.type === "message" && entry.message.role === "user") {
			deliveredThisTurn = false;
			continue;
		}
		if (entry.type !== "custom_message" || entry.customType !== SIDDHI_RESULT_MESSAGE_TYPE) continue;
		deliveredThisTurn = true;
		if ((entry.details as { jobId?: unknown } | undefined)?.jobId === jobId) deliveredThisJob = true;
		if (typeof entry.content === "string") contents.push(entry.content);
	}
	return { contents, deliveredThisTurn, deliveredThisJob };
}

function toolOutput(result: SiddhiResult, details: SiddhiToolDetails): CustomToolResult<SiddhiToolDetails> {
	return { content: [{ type: "text", text: JSON.stringify(result) }], details };
}

/** The single tool exposed to the Buddha root agent. */
export function createSiddhiTool(): CustomTool<typeof siddhiSchema, SiddhiToolDetails> {
	return {
		name: "siddhi",
		label: "Siddhi",
		description: SIDDHI_DESCRIPTION,
		parameters: siddhiSchema,
		loadMode: "essential",
		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const startedAt = Date.now();
			const session = buildToolSession(ctx);
			if (!session) {
				const result: SiddhiResult = {
					status: "blocked",
					summary: clampSummary("No live session available to delegate into."),
					jobId: "",
				};
				return toolOutput(result, {
					jobId: "",
					status: "blocked",
					workerIds: [],
					artifactRefs: [],
					rounds: 0,
				});
			}

			const job: SiddhiJob = openOrResumeJob(session, params.instruction);
			// Cross-job reuse candidates are offered only while this job owns no
			// worker of its own; once it does, its `workerIds`/`outcomes` already
			// carry continuation, so this stays a one-time offer for round 1.
			const reusableWorkers = job.workerIds.length === 0 ? collectReusableWorkers(session, job.id) : undefined;
			const outcomes: WorkerOutcome[] = [];
			// One budget signal for the whole call: a single routing round is an
			// entire subagent turn, so checking the clock only between rounds
			// would let one long worker outrun the budget entirely.
			const budgetSignal = AbortSignal.timeout(ROUTING_BUDGET_MS);
			const roundSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
			let firstProgressMs: number | undefined;
			let verifyRounds = 0;
			let repairRounds = 0;
			let rounds = 0;
			let result: SiddhiResult | undefined;
			// Latest successful worker answer. Promoted exactly once, after the
			// job settles — never once per routing round.
			let pendingAnswer: string | undefined;

			while (rounds < MAX_ROUTING_ITERATIONS && !roundSignal.aborted) {
				rounds++;
				const action = await routeNext(
					{
						instruction: params.instruction,
						job,
						capabilities: WORKER_CAPABILITIES,
						outcomes,
						reusableWorkers: rounds === 1 ? reusableWorkers : undefined,
					},
					{ session, signal: roundSignal },
				);

				if (action.action === "finish") {
					job.status = "done";
					job.lastSummary = action.summary;
					if (action.userResultRef) job.artifactRefs = mergeRefs(job.artifactRefs, [action.userResultRef]);
					saveJob(session, job);
					result = { status: "done", summary: clampSummary(action.summary), jobId: job.id };
					break;
				}
				if (action.action === "blocked") {
					job.status = "blocked";
					job.lastSummary = action.reason;
					saveJob(session, job);
					result = { status: "blocked", summary: clampSummary(action.reason), jobId: job.id };
					break;
				}

				if (action.action === "verify") verifyRounds++;
				if (action.action === "repair") repairRounds++;

				if (action.action !== "start" && !job.workerIds.includes(action.workerId)) {
					// Luna picked a worker from an earlier job in this session. Record
					// ownership before dispatching, so the journal and every later
					// round show which job the worker now belongs to.
					job.workerIds = mergeRefs(job.workerIds, [action.workerId]);
					saveJob(session, job);
				}

				const outcome = await runWorkerAction(action, {
					session,
					job,
					signal: roundSignal,
					// Progress text is UI-only: `onUpdate` never reaches the model.
					onProgress: onUpdate ? text => onUpdate({ content: [{ type: "text", text }] }) : undefined,
				});
				outcomes.push(outcome);
				firstProgressMs ??= Date.now() - startedAt;

				job.workerIds = mergeRefs(job.workerIds, [outcome.workerId]);
				job.artifactRefs = mergeRefs(job.artifactRefs, outcome.artifactRefs);
				if (outcome.answerArtifactId) {
					job.evidenceRefs = mergeRefs(job.evidenceRefs, [outcome.answerArtifactId]);
				}
				// The full answer takes exactly ONE path to the user — transcript +
				// artifact, once the job settles — never the tool result and never
				// once per round. A failed turn, an aborted turn, or a warning-banner
				// turn is not an answer and must not displace one already held; the
				// partial text stays reachable through `agent://<workerId>`.
				const answer = outcome.answerText && !outcome.failed ? answerWithoutBanners(outcome.answerText) : "";
				if (answer.length > 0) pendingAnswer = answer;
				job.lastSummary = outcome.digest;
				saveJob(session, job);
			}

			if (!result) {
				// Budget or iteration cap hit with work still open: prompt, resumable return.
				job.status = "working";
				saveJob(session, job);
				result = {
					status: "working",
					// Control-plane facts only: `job.lastSummary` holds the worker
					// digest (raw worker output for non-verifier modes), which must
					// never reach Buddha's context.
					summary: clampSummary(
						`Job ${job.id} still open after ${rounds} routing round(s), ${job.workerIds.length} worker session(s), ${job.artifactRefs.length} artifact ref(s). Call siddhi again naming ${job.id} to continue.`,
					),
					jobId: job.id,
				};
			}

			const seen = deliveryState(session, job.id);
			// "Delivered" also covers an answer promoted by an earlier call of this
			// same job, so a resumed job still reports the stop fact instead of
			// silently inviting another round.
			let delivered = seen.deliveredThisTurn || seen.deliveredThisJob;
			if (pendingAnswer && !seen.deliveredThisTurn && !seen.contents.includes(pendingAnswer)) {
				const promoted = await promoteWorkerAnswer(session, job, pendingAnswer);
				if (promoted.artifactId) {
					job.artifactRefs = mergeRefs(job.artifactRefs, [promoted.artifactId]);
					saveJob(session, job);
				}
				delivered = true;
			}
			if (result.status === "done" && delivered) {
				result = { ...result, summary: clampSummary(DELIVERED_SUMMARY) };
			}

			recordJobMetrics(session, job, {
				firstProgressMs,
				totalMs: Date.now() - startedAt,
				workerSessions: job.workerIds.length,
				verifyRounds,
				repairRounds,
				maxBuddhaTokens: peakBuddhaTokens(session),
				maxLunaTokens: peakLunaTokens(session),
			});
			logger.debug("Buddha: siddhi call settled", {
				job: job.id,
				status: result.status,
				rounds,
				summaryChars: result.summary.length,
			});

			return toolOutput(result, {
				jobId: job.id,
				status: result.status,
				workerIds: job.workerIds,
				artifactRefs: job.artifactRefs,
				rounds,
			});
		},
	};
}
