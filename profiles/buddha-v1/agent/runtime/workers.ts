/**
 * Buddha mode worker execution.
 *
 * `runWorkerAction` is the ONLY way Buddha's hidden work happens: it spawns or
 * continues an ordinary, full-capability OMP subagent (the same "task"/
 * "reviewer" agents any session can invoke) and returns a compact
 * {@link WorkerOutcome}. Nothing here builds a new agent framework — every
 * turn goes through the existing `runStructuredSubagent` (first turn) or
 * `runSubagentFollowUpTurn` (continuation) executor entry points, exactly like
 * `task/workpool.ts` already does for `workpool()`.
 *
 * Anti-leak guarantee: `runWorkerAction` never registers a job with
 * `session.asyncJobManager`. It calls the executor entry points directly and
 * awaits them inline, so `AsyncJobManager`'s delivery sink
 * (`buildAsyncResultBatchMessage`, session/async-job-delivery.ts:74) — which
 * only fires for entries produced by a *registered* async job — never sees
 * these turns. A worker's full text (`WorkerOutcome.answerText`) only ever
 * flows back through this function's return value; callers (SiddhiCore) are
 * responsible for keeping it out of Buddha's model context from there.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { runSubagentFollowUpTurn } from "@oh-my-pi/pi-coding-agent/task/executor";
import { reserveStructuredSubagentId, runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, AgentProgress, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isIrcEnabled } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { clampSummary, type RouterAction, type SiddhiJob, type WorkerMode, type WorkerOutcome } from "./types";

/** Context shared by every `runWorkerAction` call. */
export interface RunWorkerActionContext {
	session: ToolSession;
	job: SiddhiJob;
	signal?: AbortSignal;
	/** Display-only progress text for the user-visible stream. Never reaches Buddha's model context. */
	onProgress?: (text: string) => void;
}

const WORKER_MODES: Record<WorkerMode, true> = { executor: true, verifier: true, repairer: true, integrator: true };

function isWorkerMode(value: string): value is WorkerMode {
	return value in WORKER_MODES;
}

/** One cached worker: the exact `AgentDefinition` it was spawned with, plus its logical mode. */
interface CachedWorker {
	agent: AgentDefinition;
	mode: WorkerMode;
}

/**
 * Resolved-definition cache, keyed by `<ownerId>:<workerId>`. `runSubagentFollowUpTurn`
 * (executor.ts:2782 `FollowUpTurnOptions.agent`) needs the exact `AgentDefinition` object
 * the worker session was originally spawned with; `runStructuredSubagent`'s result carries
 * that resolved definition (`EffectiveSubagentPolicy.agent`, structured-subagent.ts:137), so
 * we capture it once at spawn time instead of re-resolving on every follow-up turn.
 */
const workerCache = new Map<string, CachedWorker>();

/** `<ownerId>:<workerId>` — both halves matter: ids are allocated per owning session. */
function cacheKeyFor(session: ToolSession, workerId: string): string {
	return `${session.getAgentId?.() ?? MAIN_AGENT_ID}:${workerId}`;
}

function requireBundledAgent(name: string): AgentDefinition {
	const def = getBundledAgent(name);
	if (!def) throw new Error(`buddha/workers: bundled agent "${name}" is unavailable`);
	return def;
}

/**
 * Pick the bundled agent definition for a fresh spawn in `mode`. `executor`,
 * `repairer`, and `integrator` all reuse the bundled "task" agent — the
 * general-purpose subagent whose frontmatter omits `tools` (full default set)
 * and declares `spawns: "*"` (task/agents.ts:47-61), i.e. an ordinary,
 * unrestricted OMP agent capable of read/edit/exec/skills/rules/further
 * delegation, exactly like today's root agent. `verifier` prefers the bundled
 * "reviewer" agent (read, grep, glob, bash, lsp, web_search — evidence
 * capable; prompts/agents/reviewer.md:4) and falls back to "task" only if
 * that ever stops granting evidence capability.
 */
function resolveAgentDefForMode(mode: WorkerMode): AgentDefinition {
	if (mode === "verifier") {
		const reviewer = getBundledAgent("reviewer");
		// `tools === undefined` means the full default tool set
		// (executor.ts:3006-3014 — `if (agent.tools) toolNames = ...`, else
		// `toolNames` stays undefined and downstream resolves every tool). An
		// explicit list must still carry read + an execution primitive so the
		// verifier can gather its own evidence.
		const evidenceCapable =
			reviewer !== undefined &&
			(reviewer.tools === undefined ||
				(reviewer.tools.includes("read") && (reviewer.tools.includes("bash") || reviewer.tools.includes("exec"))));
		if (reviewer && evidenceCapable) return reviewer;
		logger.debug("buddha/workers: reviewer agent lacks evidence capability; verifying with task agent instead");
	}
	return requireBundledAgent("task");
}

/** Forward live progress to the caller's UI stream only. Never touches any model-visible state. */
function forwardProgress(ctx: RunWorkerActionContext): ((progress: AgentProgress) => void) | undefined {
	const onProgress = ctx.onProgress;
	if (!onProgress) return undefined;
	return (progress: AgentProgress) => {
		const activity = progress.lastIntent || progress.currentTool || `${progress.toolCount} tool call(s) so far`;
		onProgress(`Delegated execution — ${progress.agent} ${progress.id}: ${activity}`);
	};
}

function reviewVerdict(data: unknown): { correct: boolean; explanation: string } | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.overall_correctness !== "string" || typeof record.explanation !== "string") return undefined;
	return { correct: record.overall_correctness === "correct", explanation: record.explanation };
}

function buildDigest(mode: WorkerMode, result: SingleResult): string {
	if (result.error) return `error: ${result.error}`;
	if (result.aborted) return `aborted${result.abortReason ? `: ${result.abortReason}` : ""}`;
	if (mode === "verifier") {
		const verdict = reviewVerdict(result.structuredOutput?.data);
		if (verdict) return `verdict=${verdict.correct ? "PASS" : "FAIL"}: ${verdict.explanation}`;
	}
	return result.output || "(worker produced no output)";
}

function collectArtifactRefs(workerId: string, result: SingleResult): string[] {
	// `agent://<workerId>` always resolves (retainArtifacts + the pre-reserved
	// id), so it is unconditionally the first, most reliable ref.
	const refs = [`agent://${workerId}`];
	if (result.patchPath) refs.push(result.patchPath);
	if (result.branchName) refs.push(result.branchName);
	return refs;
}

function buildOutcome(mode: WorkerMode, workerId: string, result: SingleResult): WorkerOutcome {
	const failed = result.exitCode !== 0 || result.error !== undefined || result.aborted === true;
	return {
		workerId,
		mode,
		digest: clampSummary(buildDigest(mode, result), 600),
		artifactRefs: collectArtifactRefs(workerId, result),
		failed,
		// `retainArtifacts: true` plus the pre-reserved id (reserveStructuredSubagentId,
		// structured-subagent.ts:348) means `agent://<workerId>` already IS this turn's
		// answer artifact — no separate allocation needed.
		answerArtifactId: workerId,
		answerText: result.output || undefined,
	};
}

/**
 * Build a failure outcome for a turn that threw before producing a
 * `SingleResult` (preflight rejection, a dead ref `ensureLive` refused to
 * revive, or an unexpected exception). Preserves everything already known
 * about the job so Luna can resume, steer, repair, or replace the worker —
 * the worker itself is left exactly as it was (never killed/unregistered).
 */
function buildFailureOutcome(mode: WorkerMode, workerId: string, job: SiddhiJob, error: unknown): WorkerOutcome {
	const raw = error instanceof Error ? error.message : String(error);
	// First line only, bounded: never propagate a raw stack dump outward.
	const message = raw.split("\n")[0]?.slice(0, 400) || "unknown error";
	logger.warn("buddha/workers: worker turn failed before completion; worker left live/parked for retry", {
		workerId,
		mode,
		error: message,
	});
	return {
		workerId,
		mode,
		digest: clampSummary(`worker turn failed to complete: ${message}`, 600),
		artifactRefs: Array.from(new Set([`agent://${workerId}`, ...job.artifactRefs])),
		failed: true,
	};
}

function buildInstruction(
	mode: WorkerMode,
	job: SiddhiJob,
	action: Extract<RouterAction, { action: "start" | "resume" | "steer" | "verify" | "repair" }>,
): string {
	const sections: string[] = [];
	if (mode === "verifier") {
		sections.push(
			"Independently verify the following. Do NOT fix anything — only check and report pass/fail with concrete evidence (files inspected, commands run, output observed).",
		);
		sections.push(`Verification request: ${action.instruction}`);
		if (job.doneWhen.length > 0) sections.push(`Acceptance criteria to check:\n- ${job.doneWhen.join("\n- ")}`);
		return sections.join("\n\n");
	}
	if (mode === "repairer") {
		sections.push("The following defect was found during verification. Fix it precisely; do not expand scope.");
		sections.push(`Defect: ${action.instruction}`);
		return sections.join("\n\n");
	}
	if (action.action === "start" && mode === "integrator") {
		sections.push("Combine the following artifacts into one coherent result.");
		sections.push(action.instruction);
		if (job.artifactRefs.length > 0) sections.push(`Artifacts to combine:\n- ${job.artifactRefs.join("\n- ")}`);
		return sections.join("\n\n");
	}
	if (action.action === "start") {
		sections.push(`Outcome: ${job.outcome}`);
		sections.push(action.instruction);
		if (job.constraints.length > 0) sections.push(`Constraints:\n- ${job.constraints.join("\n- ")}`);
		if (action.doneWhen.length > 0) sections.push(`Definition of done:\n- ${action.doneWhen.join("\n- ")}`);
		return sections.join("\n\n");
	}
	// resume / steer: plain continuation of an existing worker's own session.
	return action.instruction;
}

async function spawnWorker(
	mode: WorkerMode,
	action: Extract<RouterAction, { action: "start" }>,
	ctx: RunWorkerActionContext,
): Promise<WorkerOutcome> {
	const agentDef = resolveAgentDefForMode(mode);
	// Reserve the id up front (workpool.ts:290 does the same) so it is known
	// even if the run throws, and so it doubles as the `agent://`/`history://`
	// handle for this worker for the rest of its life.
	const id = await reserveStructuredSubagentId(ctx.session, { label: `siddhi-${ctx.job.id}-${mode}` });
	const message = buildInstruction(mode, ctx.job, action);
	try {
		const execution = await runStructuredSubagent({
			session: ctx.session,
			invocationKind: "eval",
			assignment: message,
			// Resolve by name through the normal discovery path (project overrides,
			// disabled-agent checks, plan-mode wrapping all still apply) rather than
			// handing the bundled definition straight through.
			agent: agentDef.name,
			identity: { id },
			keepAlive: true,
			retainArtifacts: true,
			enableLsp: true,
			enableIrc: isIrcEnabled(ctx.session.settings, ctx.session.taskDepth ?? 0),
			signal: ctx.signal,
			onProgress: forwardProgress(ctx),
		});
		workerCache.set(cacheKeyFor(ctx.session, id), { agent: execution.policy.agent, mode });
		return buildOutcome(mode, id, execution.result);
	} catch (error) {
		return buildFailureOutcome(mode, id, ctx.job, error);
	}
}

async function followUpWorker(
	mode: WorkerMode,
	action: Extract<RouterAction, { action: "resume" | "steer" | "verify" | "repair" }>,
	ctx: RunWorkerActionContext,
): Promise<WorkerOutcome> {
	const ref = AgentRegistry.global().get(action.workerId);
	if (!ref) {
		// No live or parked worker owns this state (never spawned in this
		// process, or fully unregistered) — only then do we spawn a
		// replacement, per the explicit ban on replacing a resumable job.
		logger.debug("buddha/workers: no live/parked ref for follow-up; spawning a replacement worker", {
			workerId: action.workerId,
			mode,
			action: action.action,
		});
		return spawnWorker(
			mode,
			{ action: "start", workerType: mode, instruction: action.instruction, doneWhen: ctx.job.doneWhen },
			ctx,
		);
	}
	const agentDef = workerCache.get(cacheKeyFor(ctx.session, action.workerId))?.agent ?? resolveAgentDefForMode(mode);
	const message = buildInstruction(mode, ctx.job, action);
	try {
		// `runSubagentFollowUpTurn` revives a parked session via
		// `AgentLifecycleManager.ensureLive` internally (executor.ts:2829) and
		// keeps the worker's full prior conversation — a real continuation, not
		// a fresh context.
		const result = await runSubagentFollowUpTurn({
			id: action.workerId,
			agent: agentDef,
			message,
			signal: ctx.signal,
			onProgress: forwardProgress(ctx),
			eventBus: ctx.session.eventBus,
			subagentEventBus: ctx.session.subagentEventBus,
			artifactsDir: ctx.session.getSessionFile()?.slice(0, -6),
			maxRuntimeMs: ctx.session.settings.get("task.maxRuntimeMs"),
		});
		workerCache.set(cacheKeyFor(ctx.session, action.workerId), { agent: agentDef, mode });
		return buildOutcome(mode, action.workerId, result);
	} catch (error) {
		return buildFailureOutcome(mode, action.workerId, ctx.job, error);
	}
}

/**
 * Execute one routed worker turn: spawn a fresh worker (`start`) or continue
 * an existing one (`resume`/`steer`/`verify`/`repair`). Always returns a
 * compact {@link WorkerOutcome} — never throws; execution failures are
 * captured as `{ failed: true, digest: "…" }` so Luna can react.
 */
export async function runWorkerAction(
	action: Extract<RouterAction, { action: "start" | "resume" | "steer" | "verify" | "repair" }>,
	ctx: RunWorkerActionContext,
): Promise<WorkerOutcome> {
	if (action.action === "start") {
		const mode = isWorkerMode(action.workerType) ? action.workerType : "executor";
		return spawnWorker(mode, action, ctx);
	}
	const mode: WorkerMode =
		action.action === "verify"
			? "verifier"
			: action.action === "repair"
				? "repairer"
				: (workerCache.get(cacheKeyFor(ctx.session, action.workerId))?.mode ?? "executor");
	return followUpWorker(mode, action, ctx);
}
