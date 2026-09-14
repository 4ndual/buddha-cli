import type { ToolSession } from "../tools";
import type { SingleResult, TaskParams } from "./types";

export const TASK_LIFECYCLE_SERVICE = "omp.task-lifecycle";

export type TaskLifecycleCheckpoint = "CHECK_1" | "CHECK_2" | "HARD_CANCEL";

export interface TaskLifecycleMetadata {
	lineageId: string;
	ownerId?: string;
	startedAtMonotonic: number;
	params: TaskParams;
}

export interface TaskLifecycleNotice {
	message?: string;
	details?: Record<string, unknown>;
}

/**
 * Optional policy supplied by a loaded profile extension. Core owns timers and
 * cancellation; the profile owns validation, review prompts, and presentation.
 */
export interface TaskLifecycleService {
	checkpointsMs?: { check1: number; check2: number; hardCancel: number };
	validate?(params: TaskParams, label: string): string | undefined;
	onCheckpoint?(
		checkpoint: Exclude<TaskLifecycleCheckpoint, "HARD_CANCEL">,
		metadata: TaskLifecycleMetadata,
		session: ToolSession,
	): Promise<TaskLifecycleNotice | void>;
	onHardCancel?(metadata: TaskLifecycleMetadata, session: ToolSession): Promise<TaskLifecycleNotice | void>;
	/** Optional profile-owned presentation of generic settled-run telemetry. */
	formatTelemetry?(result: SingleResult): string | undefined;
}
