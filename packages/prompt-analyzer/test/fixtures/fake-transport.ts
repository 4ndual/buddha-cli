/**
 * `OmpTransport` fixture for server tests.
 *
 * It drives the **real** `runPipeline`, stubbing only the model boundary
 * (`StageCall`), so server tests exercise real pipeline semantics — event
 * order, wave gating, cancellation — without a model provider.
 */
import type { AnalysisEvent, AnalysisRequest, OmpTransport, Stage } from "../../src/contracts";
import type { StageLogger } from "../../src/pipeline";
import { runPipeline } from "../../src/pipeline";
import { createFixtureStageCall, type StageSpec } from "./fake-stage-call";
import { createRecordingLogger } from "./recording-logger";

export interface FixtureTransport extends OmpTransport {
	/** runIds `cancel()` was called for, in call order. */
	readonly cancelledRunIds: string[];
	/** Number of times `start()` was invoked. */
	readonly startCount: number;
}

/**
 * @param specs - Canned model output per stage.
 * @param log - Stage sink handed to `runPipeline`; defaults to a silent
 * recorder. The stdout-purity harness passes the real terminal logger, which
 * is what `transport-sdk.ts` does in production.
 */
export function createFixtureTransport(specs: Partial<Record<Stage, StageSpec>>, log?: StageLogger): FixtureTransport {
	const controllers = new Map<string, AbortController>();
	const cancelledRunIds: string[] = [];
	const logger = log ?? createRecordingLogger();
	let startCount = 0;

	return {
		get cancelledRunIds() {
			return cancelledRunIds;
		},
		get startCount() {
			return startCount;
		},
		async start(): Promise<void> {
			startCount++;
		},
		analyze(request: AnalysisRequest): AsyncIterable<AnalysisEvent> {
			const controller = new AbortController();
			controllers.set(request.runId, controller);
			const { call } = createFixtureStageCall(specs);
			return (async function* stream() {
				try {
					yield* runPipeline(request, { call, log: logger, signal: controller.signal });
				} finally {
					controllers.delete(request.runId);
				}
			})();
		},
		async cancel(runId: string): Promise<void> {
			cancelledRunIds.push(runId);
			controllers.get(runId)?.abort();
		},
		async dispose(): Promise<void> {
			for (const controller of controllers.values()) controller.abort();
			controllers.clear();
		},
	};
}
