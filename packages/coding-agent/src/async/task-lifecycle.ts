import { logger } from "@oh-my-pi/pi-utils";

export type TaskCheckpoint = "CHECK_1" | "CHECK_2";

export interface TaskRuntimeMetadata {
	readonly startedAtMonotonic: number;
	readonly ownerId?: string;
	readonly lineageId: string;
	readonly data?: unknown;
}

export interface TaskLifecycleOptions {
	readonly metadata: TaskRuntimeMetadata;
	readonly checkpointsMs?: { check1: number; check2: number; hardCancel: number };
	readonly onCheckpoint: (checkpoint: TaskCheckpoint, metadata: TaskRuntimeMetadata) => void | Promise<void>;
	readonly onOwnedHardCancel: (metadata: TaskRuntimeMetadata) => void | Promise<void>;
	readonly now?: () => number;
	readonly schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
	readonly clear?: (timer: NodeJS.Timeout) => void;
}

export interface TaskLifecycle {
	stop(): void;
}

const DEFAULT_TIMEOUTS = { check1: 3 * 60_000, check2: 5 * 60_000, hardCancel: 10 * 60_000 };

export function superviseTaskLifecycle(options: TaskLifecycleOptions): TaskLifecycle {
	const now = options.now ?? (() => performance.now());
	const schedule =
		options.schedule ??
		((callback, delay) => {
			const timer = setTimeout(callback, delay);
			timer.unref?.();
			return timer;
		});
	const clear = options.clear ?? clearTimeout;
	const times = options.checkpointsMs ?? DEFAULT_TIMEOUTS;
	const timers = new Set<NodeJS.Timeout>();
	let stopped = false;
	const invoke = (kind: string, callback: () => void | Promise<void>) => {
		void Promise.resolve()
			.then(callback)
			.catch(error =>
				logger.warn("Task lifecycle callback failed", {
					kind,
					lineageId: options.metadata.lineageId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	};
	const arm = (at: number, callback: () => void) => {
		const timer = schedule(
			() => {
				timers.delete(timer);
				if (!stopped) callback();
			},
			Math.max(0, at - Math.max(0, now() - options.metadata.startedAtMonotonic)),
		);
		timers.add(timer);
	};
	arm(times.check1, () => invoke("CHECK_1", () => options.onCheckpoint("CHECK_1", options.metadata)));
	arm(times.check2, () => invoke("CHECK_2", () => options.onCheckpoint("CHECK_2", options.metadata)));
	arm(times.hardCancel, () => invoke("HARD_CANCEL", () => options.onOwnedHardCancel(options.metadata)));
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			for (const timer of timers) clear(timer);
			timers.clear();
		},
	};
}
