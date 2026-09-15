import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { hasWcdbTestAdapter, type JsonValue, WcdbMigrationTestDriver } from "./migration-test-driver";

interface BackpressureProbe extends Record<string, JsonValue> {
	recordCount: number;
	totalPayloadBytes: number;
	configuredQueueBytes: number;
	peakQueuedBytes: number;
	peakJsMaterializedBytes: number;
	largestChunkBytes: number;
	batchCalls: number;
	nativeCopiesPerChunk: number;
	payloadHashVerified: boolean;
}

interface LifecycleProbe extends Record<string, JsonValue> {
	timedOut: boolean;
	timeoutCode: string;
	cancelObserved: boolean;
	queuedBytesAfterCancel: number;
	lateWriteCommitted: boolean;
	shutdownCompleted: boolean;
	openNativeHandlesAfterShutdown: number;
	callbacksAfterShutdown: number;
}

const integrationIt = it.skipIf(!hasWcdbTestAdapter);

describe("WCDB worker byte bounds and lifecycle", () => {
	integrationIt("batches records under byte backpressure and streams an oversized payload without full JS materialization", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-worker-bytes-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const probe = await driver.invoke<BackpressureProbe>("workerBackpressureProbe", {
			recordCount: 128,
			recordBytes: 65_536,
			oversizedPayloadBytes: 4_194_304,
			queueBudgetBytes: 262_144,
			streamChunkBytes: 65_536,
		});
		expect(probe.recordCount).toBe(128);
		expect(probe.totalPayloadBytes).toBe(12_582_912);
		expect(probe.peakQueuedBytes).toBeLessThanOrEqual(probe.configuredQueueBytes);
		expect(probe.largestChunkBytes).toBeLessThanOrEqual(65_536);
		expect(probe.peakJsMaterializedBytes).toBeLessThan(probe.totalPayloadBytes);
		expect(probe.batchCalls).toBeLessThan(probe.recordCount);
		expect(probe.nativeCopiesPerChunk).toBeLessThanOrEqual(1);
		expect(probe.payloadHashVerified).toBe(true);
	});

	integrationIt("maps deadlines to cancellation, rejects late writes, and closes every native handle on shutdown", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-worker-lifecycle-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const probe = await driver.invoke<LifecycleProbe>("workerLifecycleProbe", {
			operationDelayMs: 250,
			deadlineMs: 25,
			shutdownDeadlineMs: 500,
		});
		expect(probe.timedOut).toBe(true);
		expect(probe.timeoutCode).toBe("DEADLINE_EXCEEDED");
		expect(probe.cancelObserved).toBe(true);
		expect(probe.queuedBytesAfterCancel).toBe(0);
		expect(probe.lateWriteCommitted).toBe(false);
		expect(probe.shutdownCompleted).toBe(true);
		expect(probe.openNativeHandlesAfterShutdown).toBe(0);
		expect(probe.callbacksAfterShutdown).toBe(0);
	});
});
