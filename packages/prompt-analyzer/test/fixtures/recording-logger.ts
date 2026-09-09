/**
 * Minimal `StageLogger` fixture (structurally matches `pipeline.ts`'s
 * `StageLogger` and `log.ts`'s `TerminalLogger`) that records every
 * transition instead of printing it.
 */
import type { Stage } from "../../src/contracts";

export type RecordedPhase = "started" | "completed" | "failed";

export interface RecordedStageEntry {
	stage: Stage;
	phase: RecordedPhase;
	info?: { ms?: number; error?: string };
}

export interface RecordingLogger {
	entries: RecordedStageEntry[];
	stage(stage: Stage, phase: RecordedPhase, info?: { ms?: number; error?: string }): void;
}

export function createRecordingLogger(): RecordingLogger {
	const entries: RecordedStageEntry[] = [];
	return {
		entries,
		stage(stage, phase, info) {
			entries.push({ stage, phase, info });
		},
	};
}
