import { expect, test } from "bun:test";
import { superviseTaskLifecycle } from "../src/async/task-lifecycle";

test("task lifecycle invokes profile checkpoints and owned hard cancel", async () => {
	const scheduled: Array<{ delay: number; callback: () => void }> = [];
	const events: string[] = [];
	const lifecycle = superviseTaskLifecycle({
		metadata: { lineageId: "worker-1", ownerId: "Main", startedAtMonotonic: 0 },
		checkpointsMs: { check1: 10, check2: 20, hardCancel: 30 },
		now: () => 0,
		schedule: (callback, delay) => {
			scheduled.push({ callback, delay });
			return { unref() {} } as NodeJS.Timeout;
		},
		clear: () => {},
		onCheckpoint: checkpoint => {
			events.push(checkpoint);
		},
		onOwnedHardCancel: metadata => {
			events.push(`HARD_CANCEL:${metadata.ownerId}`);
		},
	});

	expect(scheduled.map(item => item.delay)).toEqual([10, 20, 30]);
	for (const item of scheduled) item.callback();
	await Promise.resolve();
	await Promise.resolve();
	expect(events).toEqual(["CHECK_1", "CHECK_2", "HARD_CANCEL:Main"]);
	lifecycle.stop();
});

test("stopping task lifecycle leaves stock sessions inert", async () => {
	const callbacks: Array<() => void> = [];
	const events: string[] = [];
	const lifecycle = superviseTaskLifecycle({
		metadata: { lineageId: "worker-2", startedAtMonotonic: 0 },
		now: () => 0,
		schedule: callback => {
			callbacks.push(callback);
			return { unref() {} } as NodeJS.Timeout;
		},
		clear: () => {},
		onCheckpoint: checkpoint => {
			events.push(checkpoint);
		},
		onOwnedHardCancel: () => {
			events.push("HARD_CANCEL");
		},
	});
	lifecycle.stop();
	for (const callback of callbacks) callback();
	await Promise.resolve();
	expect(events).toEqual([]);
});
