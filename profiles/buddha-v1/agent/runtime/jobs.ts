/**
 * Compact durable Buddha job store.
 *
 * No new database: every transition is journaled as a JSONL `custom` session
 * entry (the established idiom — see `src/tools/todo.ts`'s
 * `USER_TODO_EDIT_CUSTOM_TYPE` persistence and
 * `SessionManager.appendCustomEntry`). An in-memory cache keyed by the
 * session's own `SessionManager` object avoids re-scanning the branch on
 * every hot read; it is populated lazily on first access per session.
 */

import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetPeakTokens } from "./metrics";
import { clampSummary, SIDDHI_JOB_CUSTOM_TYPE, type SiddhiJob, type WorkerMode } from "./types";

/**
 * Per-session job cache: `SessionManager` identity -> jobs by id.
 *
 * The manager instance survives `/new` and `/resume` (both replace its entries
 * and session id in place), so the cached session id is revalidated on every
 * access — otherwise a switched session would resume the previous session's
 * jobs and mint colliding `job_<n>` ids.
 */
const jobCaches = new WeakMap<object, { sessionId: string | null; jobs: Map<string, SiddhiJob> }>();

/** Regex for a `job_<n>` token embedded in natural-language instruction text. */
const JOB_REF_PATTERN = /\bjob_\d+\b/;

/** Extract a `job_<n>` reference from natural-language instruction text, if present. */
export function findJobRef(instruction: string): string | undefined {
	return JOB_REF_PATTERN.exec(instruction)?.[0];
}

function scanJobsFromEntries(session: ToolSession): Map<string, SiddhiJob> {
	const map = new Map<string, SiddhiJob>();
	const sm = session.sessionManager;
	if (!sm) return map;
	const entries = sm.getBranch();
	// Newest-first; keep the first (= latest) occurrence per job id.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== SIDDHI_JOB_CUSTOM_TYPE) continue;
		const job = entry.data as SiddhiJob | undefined;
		if (!job?.id || map.has(job.id)) continue;
		map.set(job.id, job);
	}
	return map;
}

function ensureCache(session: ToolSession): Map<string, SiddhiJob> {
	const key = session.sessionManager;
	if (!key) return scanJobsFromEntries(session);
	const sessionId = key.getSessionId?.() ?? null;
	let cached = jobCaches.get(key);
	if (!cached || cached.sessionId !== sessionId) {
		cached = { sessionId, jobs: scanJobsFromEntries(session) };
		jobCaches.set(key, cached);
	}
	return cached.jobs;
}

function mintJobId(existing: Iterable<SiddhiJob>): string {
	let max = 0;
	for (const job of existing) {
		const match = /^job_(\d+)$/.exec(job.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `job_${max + 1}`;
}

/** Numeric suffix of a `job_<n>` id, used to order jobs by recency. Unparseable ids sort last. */
function jobSeq(id: string): number {
	const match = /^job_(\d+)$/.exec(id);
	return match ? Number(match[1]) : Number.NaN;
}

/** The most recently minted still-open (`working`/`blocked`) job among `jobs`, if any. */
function mostRecentOpenJob(jobs: Iterable<SiddhiJob>): SiddhiJob | undefined {
	let best: SiddhiJob | undefined;
	let bestSeq = Number.NEGATIVE_INFINITY;
	for (const job of jobs) {
		if (job.status !== "working" && job.status !== "blocked") continue;
		const seq = jobSeq(job.id);
		if (Number.isNaN(seq) || seq <= bestSeq) continue;
		bestSeq = seq;
		best = job;
	}
	return best;
}

/** All known jobs for this session, newest transition per job id, from cache or a one-time scan. */
export function loadJobs(session: ToolSession): SiddhiJob[] {
	return [...ensureCache(session).values()];
}

/**
 * Resolve the job this instruction belongs to, in strict precedence order:
 * an explicit `job_<n>` reference, else this session's most recent job that
 * is still open (`working`/`blocked`), else a freshly minted job. Precedence
 * only — no natural-language "is this a continuation?" heuristic.
 */
export function openOrResumeJob(session: ToolSession, instruction: string): SiddhiJob {
	const cache = ensureCache(session);
	const ref = findJobRef(instruction);
	if (ref) {
		const existing = cache.get(ref);
		if (existing) return existing;
	}
	// A follow-up that names no job still means "continue what we were doing"
	// while this session's latest job is unfinished: resuming keeps its stored
	// state (workers, artifacts, done-when) instead of starting from nothing.
	const openJob = mostRecentOpenJob(cache.values());
	if (openJob) return openJob;
	// A fresh job starts a fresh token-peak window; a resume keeps the running one.
	resetPeakTokens(session);
	const branch = session.sessionManager?.getBranch() ?? [];
	const job: SiddhiJob = {
		id: mintJobId(cache.values()),
		status: "working",
		userRequestRef: branch.at(-1)?.id ?? "",
		outcome: instruction,
		constraints: [],
		doneWhen: [],
		workerIds: [],
		artifactRefs: [],
		evidenceRefs: [],
		assumptions: [],
		lastSummary: "",
	};
	saveJob(session, job);
	return job;
}

/** Journal a job transition and refresh the in-memory cache. */
export function saveJob(session: ToolSession, job: SiddhiJob): void {
	ensureCache(session).set(job.id, job);
	// Journal a snapshot: the live job keeps mutating, and a later session-file
	// rewrite re-serializes in-memory entries — an aliased object would
	// retroactively rewrite every earlier transition of this job.
	session.sessionManager?.appendCustomEntry(SIDDHI_JOB_CUSTOM_TYPE, { ...job });
}

/** Hard cap on cross-job worker candidates surfaced to the router. */
const MAX_REUSABLE_WORKERS = 4;
/** Per-worker digest cap inside the reusable-worker block — routing-grade only, never raw worker output. */
const MAX_REUSABLE_DIGEST_CHARS = 200;

/**
 * Workers owned by this session's *other* jobs, most recently minted job
 * first and each job's most recently added worker first. They are still live
 * or parked and already hold the relevant repo state, so the router can
 * resume/steer one instead of spawning a fresh-context worker for a
 * follow-up. `excludeJobId` (the job being routed) is skipped: its own
 * workers already reach the router through `job.workerIds`/`outcomes`.
 *
 * The per-worker mode is not persisted on `SiddhiJob`; `executor` is the same
 * fallback `runWorkerAction` already applies when a worker's cached mode is
 * unknown (workers.ts), and it is only a routing label here.
 */
export function collectReusableWorkers(
	session: ToolSession,
	excludeJobId: string,
): { workerId: string; mode: WorkerMode; jobId: string; digest: string }[] {
	const jobs = [...ensureCache(session).values()]
		.filter(job => job.id !== excludeJobId)
		.sort((a, b) => jobSeq(b.id) - jobSeq(a.id));
	const entries: { workerId: string; mode: WorkerMode; jobId: string; digest: string }[] = [];
	for (const job of jobs) {
		for (let i = job.workerIds.length - 1; i >= 0; i--) {
			const workerId = job.workerIds[i];
			if (!workerId) continue;
			if (entries.length >= MAX_REUSABLE_WORKERS) return entries;
			entries.push({
				workerId,
				mode: "executor",
				jobId: job.id,
				digest: clampSummary(job.lastSummary, MAX_REUSABLE_DIGEST_CHARS),
			});
		}
	}
	return entries;
}
