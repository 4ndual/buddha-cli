/**
 * OMP SDK transport.
 *
 * Why the SDK and not RPC mode: RPC (`--rpc`, JSONL over stdio) has no
 * per-request system prompt, model, tool-restriction or structured-output
 * override — those are launch-time flags only (`rpc-types.ts:29-101`,
 * `main.ts:1071`). Four stage instructions would therefore need four RPC
 * processes and still give no tool restriction per call. `createAgentSession`
 * (`packages/coding-agent/src/sdk.ts:1330`) exposes all of it per session:
 * `systemPrompt` (:431), `modelPattern` (:410), `thinkingLevel` (:418),
 * `toolNames` + `restrictToolNames` (:555-557), `sessionManager` (:617).
 * `OmpTransport` stays the seam, so an RPC adapter remains swappable.
 *
 * Session economics: the stage instruction is a **creation-time** option. The
 * session rebuilds and re-applies its own base system prompt at every turn
 * (`session-tools.ts:1476`), so a post-creation `Agent.setSystemPrompt` is
 * overwritten before the request goes out — one session therefore cannot serve
 * two different stage instructions. The pool keeps one session per stage
 * (four at most, each created once and reused for every later run, with its
 * transcript cleared between uses) and gates dispatch on a semaphore of
 * `MAX_CONCURRENT_CALLS` (2), which is exactly wave 1's width. No run can
 * exceed two concurrent model calls.
 *
 * Nothing here writes to stdout. Protocol detail goes to `logger.debug`
 * (rotating file, never console) and only when `verbose` is set.
 */

import { AgentRegistry, createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger } from "@oh-my-pi/pi-utils";
import { type AnalysisEvent, type AnalysisRequest, MAX_CONCURRENT_CALLS, type OmpTransport, type Stage } from "./contracts";
import { createTerminalLogger } from "./log";
import { resolveAnalyzerModel } from "./model";
import { runPipeline, type StageCall } from "./pipeline";

export interface SdkTransportOptions {
	/** Model selector, e.g. `anthropic/claude-sonnet-5:low`. Default: `ANALYZER_MODEL` env, else the built-in default. */
	model?: string;
	/** Unlock protocol detail in the debug log. Never changes stdout. */
	verbose?: boolean;
}

/** Reason recorded on the SDK abort path when a run is cancelled. */
const CANCEL_REASON = "prompt-analyzer: run cancelled";

/**
 * Drive one stage turn on an already-prepared session: stream `text_delta`
 * into `onDelta`, resolve the buffered text at `agent_end`.
 */
function runTurn(
	session: CreateAgentSessionResult["session"],
	user: string,
	onDelta: (text: string) => void,
	signal: AbortSignal,
	verbose: boolean,
): Promise<string> {
	let buffer = "";
	const { promise: completed, resolve: settle, reject: fail } = Promise.withResolvers<string>();
	// The turn can fail before the awaiter attaches (an error frame arriving
	// while `prompt()` is still resolving); keep the rejection handled.
	void completed.catch(() => {});

	const unsubscribe = session.subscribe(event => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				buffer += update.delta;
				onDelta(update.delta);
				return;
			}
			if (update.type === "error") {
				const message = update.error.errorMessage ?? `model stream ended: ${update.reason}`;
				fail(new Error(message));
			}
			return;
		}
		// `isTerminal === false` means an async delivery will resume the session
		// before its true final settle; only a terminal end completes the stage.
		if (event.type === "agent_end" && event.isTerminal !== false) settle(buffer);
	});

	const onAbort = (): void => {
		fail(new DOMException(CANCEL_REASON, "AbortError"));
		void session.abort({ reason: CANCEL_REASON }).catch((error: unknown) => {
			if (verbose) logger.debug("prompt-analyzer: session abort failed", { error: String(error) });
		});
	};
	signal.addEventListener("abort", onAbort, { once: true });

	return (async () => {
		try {
			if (signal.aborted) throw new DOMException(CANCEL_REASON, "AbortError");
			const forwarded = await session.prompt(user, { expandPromptTemplates: false, userInitiated: false });
			if (!forwarded) throw new Error("stage prompt was handled locally and never reached the model");
			return await completed;
		} finally {
			signal.removeEventListener("abort", onAbort);
			unsubscribe();
		}
	})();
}

/**
 * One reusable session per stage, with dispatch gated on a semaphore of
 * {@link MAX_CONCURRENT_CALLS}. Waiters are served FIFO.
 */
class SessionPool {
	readonly #sessions = new Map<Stage, Promise<CreateAgentSessionResult>>();
	readonly #waiters: Array<() => void> = [];
	readonly #create: (stage: Stage, system: string) => Promise<CreateAgentSessionResult>;
	readonly #verbose: boolean;
	#inFlight = 0;
	#peakInFlight = 0;
	/**
	 * Session construction is serialized. Two `createAgentSession` calls racing
	 * each other fail with `Agent "<id>" was replaced during session
	 * initialization` (sdk.ts:4018), since startup touches process-global
	 * state. Stage *calls* still overlap — only the one-time build is ordered.
	 */
	#building: Promise<unknown> = Promise.resolve();
	#disposed = false;

	constructor(create: (stage: Stage, system: string) => Promise<CreateAgentSessionResult>, verbose: boolean) {
		this.#create = create;
		this.#verbose = verbose;
	}

	/** Sessions built so far — at most one per stage. */
	get liveSessions(): number {
		return this.#sessions.size;
	}

	/** Highest number of model calls ever in flight at once. */
	get peakConcurrentCalls(): number {
		return this.#peakInFlight;
	}

	async call(
		stage: Stage,
		system: string,
		user: string,
		onDelta: (text: string) => void,
		signal: AbortSignal,
	): Promise<string> {
		if (this.#disposed) throw new Error("transport disposed");
		if (this.#inFlight >= MAX_CONCURRENT_CALLS) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			await promise;
		}
		this.#inFlight += 1;
		this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight);
		try {
			if (this.#disposed) throw new Error("transport disposed");
			let created = this.#sessions.get(stage);
			if (created === undefined) {
				created = this.#building.then(
					() => this.#create(stage, system),
					() => this.#create(stage, system),
				);
				this.#sessions.set(stage, created);
				this.#building = created.catch(() => {});
			}
			const { session } = await created;
			// Reuse without bleed: the stage instruction is fixed at creation, so
			// only the previous run's transcript has to go.
			session.agent.replaceMessages([]);
			if (this.#verbose) {
				logger.debug("prompt-analyzer: stage call dispatched", {
					stage,
					inFlight: this.#inFlight,
					userChars: user.length,
				});
			}
			return await runTurn(session, user, onDelta, signal, this.#verbose);
		} finally {
			this.#inFlight -= 1;
			this.#waiters.shift()?.();
		}
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		const pending = [...this.#sessions.values()];
		this.#sessions.clear();
		for (const waiter of this.#waiters.splice(0)) waiter();
		await Promise.allSettled(
			pending.map(async created => {
				const { session } = await created;
				await session.dispose();
			}),
		);
	}
}

/**
 * Build the SDK-backed transport.
 *
 * `analyze()` delegates to {@link runPipeline} with a `StageCall` bound to the
 * pool and a per-run `AbortController`; `cancel(runId)` aborts that controller,
 * which propagates to the in-flight provider stream via `AgentSession.abort`.
 */
export function createSdkTransport(options: SdkTransportOptions = {}): OmpTransport {
	const verbose = options.verbose === true;
	const log = createTerminalLogger(verbose);
	const resolved = resolveAnalyzerModel(
		options.model === undefined ? process.env : { ...process.env, ANALYZER_MODEL: options.model },
	);
	// Session titles would be a second, unrelated model call per session.
	process.env.PI_NO_TITLE ??= "1";

	const pool = new SessionPool(
		(stage, system) =>
			createAgentSession({
				// The stage instruction fully replaces the default prompt blocks
				// (sdk.ts:3244-3253), and is re-applied on every per-turn rebuild.
				systemPrompt: system,
				modelPattern: resolved.modelPattern,
				thinkingLevel: resolved.thinkingLevel,
				// Stage calls are tool-free and JSON-only.
				toolNames: [],
				restrictToolNames: true,
				sessionManager: SessionManager.inMemory(),
				// A private registry plus a distinct id per session keeps the
				// analyzer's sessions out of the process-global "Main" roster race
				// (coding-agent CHANGELOG: concurrent createAgentSession with the
				// default agent id fails initialization).
				agentRegistry: new AgentRegistry(),
				agentId: `prompt-analyzer-${stage}`,
				agentDisplayName: "prompt-analyzer",
				agentName: "prompt-analyzer",
				// Nothing ambient may join the session: no extensions, MCP, LSP,
				// python preflight or UI-only tools.
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				skipPythonPreflight: true,
				requireYieldTool: false,
				hasUI: false,
			}),
		verbose,
	);

	const runs = new Map<string, AbortController>();
	let started = false;

	const call: StageCall = (stage, system, user, onDelta, signal) => pool.call(stage, system, user, onDelta, signal);

	return {
		/** Idempotent: repeated calls never build a second pool. */
		async start(): Promise<void> {
			if (started) return;
			started = true;
			log.detail(`model ${resolved.modelPattern}${resolved.thinkingLevel ? `:${resolved.thinkingLevel}` : ""}`);
			if (verbose) {
				logger.debug("prompt-analyzer: transport started", {
					model: resolved.modelPattern,
					thinkingLevel: resolved.thinkingLevel ?? "default",
					maxConcurrentCalls: MAX_CONCURRENT_CALLS,
				});
			}
		},

		analyze(request: AnalysisRequest): AsyncIterable<AnalysisEvent> {
			const controller = new AbortController();
			runs.set(request.runId, controller);
			return (async function* stream() {
				try {
					yield* runPipeline(request, { call, log, signal: controller.signal });
				} finally {
					// A consumer that breaks out early (a superseded run) must not
					// leave provider streams alive.
					controller.abort(CANCEL_REASON);
					runs.delete(request.runId);
				}
			})();
		},

		async cancel(runId: string): Promise<void> {
			const controller = runs.get(runId);
			if (!controller) return;
			controller.abort(CANCEL_REASON);
			if (verbose) logger.debug("prompt-analyzer: run cancelled", { runId });
		},

		async dispose(): Promise<void> {
			for (const controller of runs.values()) controller.abort(CANCEL_REASON);
			runs.clear();
			await pool.dispose();
			if (verbose) logger.debug("prompt-analyzer: transport disposed", { liveSessions: pool.liveSessions });
		},
	};
}
