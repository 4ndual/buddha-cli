/**
 * Deterministic `StageCall` fixture for pipeline/server tests.
 *
 * Records per-call start/finish timestamps (for concurrency assertions in
 * pipeline.test.ts) and honors `AbortSignal` the same way a real transport
 * must: a call in flight rejects with an `AbortError` as soon as the signal
 * fires, it never silently resolves.
 */
import type { Stage } from "../../src/contracts";

export type FixtureStageCall = (
	stage: Stage,
	system: string,
	user: string,
	onDelta: (text: string) => void,
	signal: AbortSignal,
) => Promise<string>;

export interface StageCallLogEntry {
	stage: Stage;
	startedAt: number;
	finishedAt: number;
	/** The user message this call received, for asserting what a re-ask says. */
	user: string;
}

export interface StageSpec {
	/** Well-formed JSON text to resolve with. */
	json?: string;
	/** Per-invocation responses for this stage; the last one repeats. Overrides `json`. */
	jsonSequence?: string[];
	/** Deliberately malformed text (not valid JSON) to resolve with instead of `json`. */
	malformed?: string;
	/** Milliseconds to wait (abortable) before resolving. Default 0. */
	delayMs?: number;
	/** Streamed chunks delivered via `onDelta` before resolving; default is one chunk of the full text. */
	chunks?: string[];
}

function abortError(): Error {
	return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function delayOrAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError());
	if (ms <= 0) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(abortError());
	};
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/** Build a `StageCall` fixture plus a log of when each stage actually ran. */
export function createFixtureStageCall(specs: Partial<Record<Stage, StageSpec>>): {
	call: FixtureStageCall;
	log: StageCallLogEntry[];
} {
	const log: StageCallLogEntry[] = [];
	const callsPerStage: Partial<Record<Stage, number>> = {};
	const call: FixtureStageCall = async (stage, _system, user, onDelta, signal) => {
		const spec = specs[stage] ?? { json: "{}" };
		const attempt = callsPerStage[stage] ?? 0;
		callsPerStage[stage] = attempt + 1;
		const startedAt = performance.now();
		await delayOrAbort(spec.delayMs ?? 0, signal);
		const sequenced = spec.jsonSequence?.[Math.min(attempt, spec.jsonSequence.length - 1)];
		const text = spec.malformed ?? sequenced ?? spec.json ?? "{}";
		const chunks = spec.chunks ?? [text];
		for (const chunk of chunks) onDelta(chunk);
		const finishedAt = performance.now();
		log.push({ stage, startedAt, finishedAt, user });
		return text;
	};
	return { call, log };
}
