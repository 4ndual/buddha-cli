/**
 * Terminal logging for the live prompt analyzer.
 *
 * Every line goes to **stderr**, never stdout: stdout stays clean so the
 * process can be piped/redirected without human log noise mixing into any
 * machine-readable stream. Default output is a short narrative of the run —
 * never credentials, never whole prompts, never whole model responses, never
 * per-token deltas. `verbose` unlocks protocol/frame detail, still on stderr.
 */
import type { Stage } from "./contracts";

/** Phase of a stage transition, matching the pipeline's `StageLogger`. */
export type StagePhase = "started" | "completed" | "failed";

/** Human labels for the pipeline stages. */
const STAGE_LABEL: Record<Stage, string> = {
	detect_context: "Context detection",
	resolve_context: "Context resolution",
	paraphrase: "Paraphrase",
	categorize: "Categorization",
	analyze: "Selected analysis",
	verify: "Verification",
};

/**
 * Structurally compatible with the pipeline's `StageLogger`, so `runPipeline`
 * can take this object directly as `deps.log` with no adapter.
 */
export interface TerminalLogger {
	/** Emit one concise human line. */
	line(text: string): void;
	/** Emit protocol/internal detail; suppressed unless `verbose`. */
	detail(text: string): void;
	/** Stage transition, in the pipeline's `StageLogger` shape. */
	stage(stage: Stage, phase: StagePhase, info?: { ms?: number; error?: string }): void;
	/** True when protocol detail is enabled. */
	readonly verbose: boolean;
}

/** `1.2s` for a second or more, `840ms` below that. */
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Collapse a failure to a single short line; never dump a model response. */
function formatError(error: string): string {
	const firstLine = error.split("\n", 1)[0] ?? error;
	return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

/**
 * Build a stderr-only logger.
 * @param verbose - When true, `detail()` lines are printed too.
 */
export function createTerminalLogger(verbose: boolean): TerminalLogger {
	const write = (text: string): void => {
		process.stderr.write(`${text}\n`);
	};
	return {
		verbose,
		line: write,
		detail(text: string): void {
			if (verbose) write(`  · ${text}`);
		},
		stage(stage: Stage, phase: StagePhase, info?: { ms?: number; error?: string }): void {
			const label = STAGE_LABEL[stage];
			const took = info?.ms === undefined ? "" : ` in ${formatDuration(info.ms)}`;
			if (phase === "started") {
				write(`${label} started`);
				return;
			}
			if (phase === "failed") {
				write(`${label} failed${took}${info?.error ? `: ${formatError(info.error)}` : ""}`);
				return;
			}
			// The verify stage's success is the run's success; say so plainly.
			write(stage === "verify" ? `Analysis verified${took}` : `${label} completed${took}`);
		},
	};
}
