/**
 * Buddha mode instrumentation.
 *
 * Every function here writes to `logger` only — nothing it produces can reach
 * a model. That is the whole point: Buddha's context must stay exactly
 * {5-line system prompt, user conversation, clamped `SiddhiResult.summary`},
 * so its own token accounting has to live outside the transcript entirely.
 *
 * Why not `SessionManager.appendModelUsage` (session-manager.ts:2324)? Three
 * hard blockers, not a preference:
 *   1. `ModelUsageEntry` (session/session-entries.ts:79-90) requires a real
 *      `stopReason: StopReason` ("stop" | "length" | "toolUse" | "error" |
 *      "aborted", ai/src/types.ts:872) and a full `Usage`
 *      (catalog/src/types.ts:101-111: input, output, cacheRead, cacheWrite,
 *      totalTokens — all required). None of the three call contracts below
 *      carries a stop reason or cache buckets, and zero-filling them would
 *      push invented numbers into the durable per-session ledger that usage
 *      reporting reads as ground truth.
 *   2. It also requires real `provider`/`model`/`api`, which these compact
 *      Buddha contracts deliberately do not thread through.
 *   3. The object actually passed as `session` at every Buddha call site is a
 *      `ToolSession`, whose `sessionManager` is a narrowed Pick that excludes
 *      `appendModelUsage` outright (tools/index.ts:265-268) — so the method is
 *      not even reachable from here.
 * The call sites that DO own a real completion (the Luna router's provider
 * call) are the correct place to append genuine model usage, with their own
 * real provider/model/stopReason.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SiddhiJob } from "./types";

/** Peak token observations for one session, fed by the record* functions below. */
interface PeakTokens {
	buddha: number;
	luna: number;
}

/**
 * Peaks keyed by session id. `recordJobMetrics` needs `maxBuddhaTokens` /
 * `maxLunaTokens`, but the callers that observe those numbers
 * (`recordBuddhaTurn`, `recordLunaCall`) run on a different code path from the
 * one that settles a job, so the running max is held here instead of being
 * threaded through the router and worker contracts.
 */
const peaks = new Map<string, PeakTokens>();

const UNKNOWN_SESSION = "<unknown-session>";

function sessionKey(session: unknown): string {
	if (!session || typeof session !== "object") return UNKNOWN_SESSION;
	const candidate = session as { getSessionId?: () => string | null | undefined; sessionId?: unknown };
	if (typeof candidate.getSessionId === "function") {
		try {
			return candidate.getSessionId() ?? UNKNOWN_SESSION;
		} catch {
			return UNKNOWN_SESSION;
		}
	}
	return typeof candidate.sessionId === "string" ? candidate.sessionId : UNKNOWN_SESSION;
}

function peaksFor(session: unknown): PeakTokens {
	const key = sessionKey(session);
	const existing = peaks.get(key);
	if (existing) return existing;
	const created: PeakTokens = { buddha: 0, luna: 0 };
	peaks.set(key, created);
	return created;
}

/**
 * Record one Buddha (root) turn's context composition. `info` is expected to
 * come from the existing breakdown helpers — `computeContextBreakdown` /
 * `computeNonMessageBreakdown` (modes/utils/context-usage.ts:238/268) or
 * `AgentSession.getContextBreakdown` — never from a new counter.
 */
export function recordBuddhaTurn(
	session: unknown,
	info: {
		totalTokens: number;
		systemPromptTokens: number;
		toolSchemaTokens: number;
		conversationTokens: number;
		siddhiResultTokens: number;
	},
): void {
	const observed = peaksFor(session);
	observed.buddha = Math.max(observed.buddha, info.totalTokens);
	logger.debug("buddha: root turn context breakdown", {
		sessionId: sessionKey(session),
		...info,
		// Everything Buddha spends that is NOT its own prompt, tool schema, or
		// the clamped siddhi results — i.e. leakage if it ever grows.
		unaccountedTokens:
			info.totalTokens -
			(info.systemPromptTokens + info.toolSchemaTokens + info.conversationTokens + info.siddhiResultTokens),
		peakBuddhaTokens: observed.buddha,
	});
}

/**
 * Record one Luna router decision: its own token spend, latency, the action it
 * chose, and how much worker reuse that action achieved. This is the only
 * accounting the router's hidden call gets — it never enters any transcript.
 */
export function recordLunaCall(
	session: unknown,
	info: {
		inputTokens: number;
		outputTokens: number;
		latencyMs: number;
		action: string;
		workersStarted: number;
		workersReused: number;
	},
): void {
	const observed = peaksFor(session);
	observed.luna = Math.max(observed.luna, info.inputTokens + info.outputTokens);
	logger.debug("buddha: luna router decision", {
		sessionId: sessionKey(session),
		...info,
		totalTokens: info.inputTokens + info.outputTokens,
		peakLunaTokens: observed.luna,
	});
}

/**
 * Record a settled Buddha job: wall-clock shape, how many worker sessions and
 * verify/repair rounds it took, and the peak Buddha/Luna context sizes seen
 * while it ran.
 */
export function recordJobMetrics(
	session: unknown,
	job: SiddhiJob,
	info: {
		firstProgressMs?: number;
		totalMs: number;
		workerSessions: number;
		verifyRounds: number;
		repairRounds: number;
		maxBuddhaTokens: number;
		maxLunaTokens: number;
	},
): void {
	logger.info("buddha: job settled", {
		sessionId: sessionKey(session),
		jobId: job.id,
		status: job.status,
		workerIds: job.workerIds.length,
		artifactRefs: job.artifactRefs.length,
		evidenceRefs: job.evidenceRefs.length,
		assumptions: job.assumptions.length,
		...info,
	});
}

/** Highest total context size observed for a Buddha turn since the last reset. */
export function peakBuddhaTokens(session: unknown): number {
	return peaksFor(session).buddha;
}

/** Highest single-call token total observed for a Luna router decision since the last reset. */
export function peakLunaTokens(session: unknown): number {
	return peaksFor(session).luna;
}

/** Scope the peaks to one job: call when a NEW job opens, not when resuming one. */
export function resetPeakTokens(session: unknown): void {
	peaks.delete(sessionKey(session));
}
