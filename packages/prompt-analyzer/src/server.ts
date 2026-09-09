/**
 * Live prompt analyzer server: static UI on `/`, event stream on `/ws`.
 *
 * Browser protocol
 * - client -> server: `{ type: "analyze", rawPrompt }` | `{ type: "cancel", runId }`
 * - server -> client: one {@link AnalysisEvent} JSON per WebSocket message
 *
 * Invariants
 * - The latest prompt hash always wins. A differing hash supersedes the
 *   in-flight run: `run_stale` for the old runId, `transport.cancel(oldRunId)`,
 *   and every late frame from that run is dropped **server-side**.
 * - An `analyze` whose hash equals the in-flight run is idempotent: the socket
 *   attaches to the existing run, no second run starts.
 * - A fresh socket is pushed a bounded snapshot of the live run, so a reload
 *   mid-run never shows an empty page.
 */
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import type { AnalysisEvent, AnalysisRequest, ConversationTurn, OmpTransport, Stage } from "./contracts";
import { createTerminalLogger } from "./log";

/** Stage order used when replaying a snapshot to a reconnecting browser. */
const STAGE_ORDER: readonly Stage[] = ["paraphrase", "categorize", "analyze", "verify"] as const;

/** Per-stage cap on retained streaming text, so a reconnect cannot blow memory. */
const DELTA_TAIL_LIMIT = 4096;

/** Directory holding the browser assets (owned by the UI slice). */
const PUBLIC_DIR = path.resolve(import.meta.dir, "..", "public");

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

/**
 * `sha256(rawPrompt + turns)` hex, first 12 chars. The server is the only hash
 * authority.
 *
 * The conversation is part of the identity, not just the prompt text. "how do
 * i test it?" asked after two different conversations is two different
 * questions, and the same words must not collide into one run - otherwise the
 * idempotence check would attach the second ask to the first ask's answer and
 * silently resolve `it` against the wrong history. A turn-by-turn replay sends
 * many identical prompts under different histories, so this is load-bearing.
 */
export function hashPrompt(rawPrompt: string, turns: readonly ConversationTurn[] = []): string {
	const hash = createHash("sha256").update(rawPrompt, "utf8");
	for (const turn of turns) {
		// NUL delimits: no turn text can forge a boundary and alias another
		// conversation's hash.
		hash.update("\0", "utf8").update(turn.role, "utf8").update("\0", "utf8").update(turn.text, "utf8");
	}
	return hash.digest("hex").slice(0, 12);
}

/** Bounded per-stage record, sufficient to rebuild the UI after a reload. */
interface StageSnapshot {
	started?: AnalysisEvent;
	deltaTail: string;
	settled?: AnalysisEvent;
}

interface RunState {
	runId: string;
	promptHash: string;
	started?: AnalysisEvent;
	stages: Partial<Record<Stage, StageSnapshot>>;
	terminal?: AnalysisEvent;
	finished: boolean;
	stale: boolean;
}

/** Lazily create the per-stage slot; three call sites need identical creation. */
function stageSlot(run: RunState, stage: Stage): StageSnapshot {
	const existing = run.stages[stage];
	if (existing) return existing;
	const slot: StageSnapshot = { deltaTail: "" };
	run.stages[stage] = slot;
	return slot;
}

/** Fold one event into the run's bounded snapshot. */
function record(run: RunState, event: AnalysisEvent): void {
	switch (event.type) {
		case "run_started":
			run.started = event;
			break;
		case "stage_started":
			stageSlot(run, event.stage).started = event;
			break;
		case "stage_delta": {
			const slot = stageSlot(run, event.stage);
			const merged = slot.deltaTail + event.text;
			slot.deltaTail = merged.length > DELTA_TAIL_LIMIT ? merged.slice(merged.length - DELTA_TAIL_LIMIT) : merged;
			break;
		}
		case "stage_completed":
		case "stage_failed":
			stageSlot(run, event.stage).settled = event;
			break;
		case "run_verified":
		case "run_cancelled":
		case "run_stale":
			run.terminal = event;
			run.finished = true;
			break;
	}
}

/** Replay order: `run_started`, then per stage started -> delta tail -> settled, then terminal. */
function snapshot(run: RunState): AnalysisEvent[] {
	const events: AnalysisEvent[] = [];
	if (run.started) events.push(run.started);
	for (const stage of STAGE_ORDER) {
		const slot = run.stages[stage];
		if (!slot) continue;
		if (slot.started) events.push(slot.started);
		if (slot.deltaTail) events.push({ type: "stage_delta", runId: run.runId, stage, text: slot.deltaTail });
		if (slot.settled) events.push(slot.settled);
	}
	if (run.terminal) events.push(run.terminal);
	return events;
}

type ClientMessage =
	| { type: "analyze"; rawPrompt: string; turns: readonly ConversationTurn[] }
	| { type: "cancel"; runId: string };

/**
 * Coerce untrusted `turns` into the contract shape, dropping anything malformed.
 *
 * A bad turn degrades context resolution; it must never fault the run. Unknown
 * roles are kept as-is because the resolver only reads them for provenance.
 */
function parseTurns(value: unknown): readonly ConversationTurn[] {
	if (!Array.isArray(value)) return [];
	const turns: ConversationTurn[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const turn = entry as Record<string, unknown>;
		if (typeof turn.role !== "string" || typeof turn.text !== "string") continue;
		turns.push({ role: turn.role, text: turn.text });
	}
	return turns;
}

function parseClientMessage(raw: string): ClientMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const message = parsed as Record<string, unknown>;
	if (message.type === "analyze" && typeof message.rawPrompt === "string") {
		return { type: "analyze", rawPrompt: message.rawPrompt, turns: parseTurns(message.turns) };
	}
	if (message.type === "cancel" && typeof message.runId === "string") {
		return { type: "cancel", runId: message.runId };
	}
	return undefined;
}

/** Resolve a URL path inside `public/`, refusing traversal outside it. */
function resolvePublicPath(pathname: string): string | undefined {
	const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
	const resolved = path.resolve(PUBLIC_DIR, relative);
	if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) return undefined;
	return resolved;
}

export interface StartServerOptions {
	port: number;
	transport: OmpTransport;
	verbose: boolean;
}

export interface RunningServer {
	port: number;
	close(): Promise<void>;
}

/** Start the analyzer HTTP + WebSocket server. */
export function startServer(options: StartServerOptions): Promise<RunningServer> {
	const { transport, verbose } = options;
	const log = createTerminalLogger(verbose);
	const sockets = new Set<ServerWebSocket<undefined>>();
	let current: RunState | undefined;
	let closing = false;

	const broadcast = (event: AnalysisEvent): void => {
		const frame = JSON.stringify(event);
		for (const socket of sockets) socket.send(frame);
		log.detail(`-> ${event.type}${"stage" in event ? ` ${event.stage}` : ""} (${sockets.size} client(s))`);
	};

	/** Consume one run's event stream; drop everything once the run is superseded. */
	const pump = async (run: RunState, request: AnalysisRequest): Promise<void> => {
		try {
			for await (const event of transport.analyze(request)) {
				if (current !== run || run.stale) {
					log.detail(`dropped ${event.type} from stale run ${run.runId}`);
					break;
				}
				if (event.runId !== run.runId) {
					log.detail(`dropped ${event.type} with foreign runId ${event.runId}`);
					continue;
				}
				record(run, event);
				broadcast(event);
			}
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "";
			if (current === run && !run.stale) {
				log.line(`Analysis failed: ${message}`);
				const cancelled: AnalysisEvent = { type: "run_cancelled", runId: run.runId };
				record(run, cancelled);
				broadcast(cancelled);
			} else {
				log.detail(`stale run ${run.runId} ended with: ${message}`);
			}
		} finally {
			run.finished = true;
		}
	};

	const onAnalyze = (rawPrompt: string, turns: readonly ConversationTurn[]): void => {
		const promptHash = hashPrompt(rawPrompt, turns);
		if (current && !current.finished && !current.stale) {
			if (current.promptHash === promptHash) {
				// Idempotent: every socket already receives this run's frames (snapshot on
				// open, live broadcast after), so re-requesting it is a no-op.
				log.detail(`analyze ignored, run ${current.runId} already in flight for ${promptHash}`);
				return;
			}
			const stale = current;
			stale.stale = true;
			stale.finished = true;
			broadcast({ type: "run_stale", runId: stale.runId });
			log.line(`Prompt superseded: ${stale.promptHash}`);
			void transport.cancel(stale.runId).catch((error: unknown) => {
				log.detail(`cancel(${stale.runId}) failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		const run: RunState = {
			runId: randomUUID(),
			promptHash,
			stages: {},
			finished: false,
			stale: false,
		};
		current = run;
		log.line(`Prompt accepted: ${promptHash}`);
		void pump(run, { runId: run.runId, promptHash, rawPrompt, turns });
	};

	const server = Bun.serve({
		port: options.port,
		fetch(request, bunServer) {
			const url = new URL(request.url);
			if (url.pathname === "/ws") {
				return bunServer.upgrade(request) ? undefined : new Response("websocket upgrade failed", { status: 400 });
			}
			const filePath = resolvePublicPath(url.pathname);
			if (!filePath) return new Response("not found", { status: 404 });
			const file = Bun.file(filePath);
			const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
			return file
				.exists()
				.then(exists =>
					exists
						? new Response(file, { headers: type ? { "content-type": type } : undefined })
						: new Response("not found", { status: 404 }),
				);
		},
		websocket: {
			open(socket: ServerWebSocket<undefined>) {
				sockets.add(socket);
				log.line("Browser connected");
				// Only an in-flight run is replayed: a reload mid-run must not show an
				// empty page, but a fresh socket must not be handed a finished run.
				if (current && !current.stale && !current.finished) {
					const frames = snapshot(current);
					if (frames.length > 0) {
						log.detail(`replaying ${frames.length} frame(s) of run ${current.runId}`);
						for (const event of frames) socket.send(JSON.stringify(event));
					}
				}
			},
			message(_socket: ServerWebSocket<undefined>, raw: string | Buffer) {
				const message = parseClientMessage(typeof raw === "string" ? raw : raw.toString("utf8"));
				if (!message) {
					log.detail("ignored malformed client frame");
					return;
				}
				if (message.type === "analyze") {
					onAnalyze(message.rawPrompt, message.turns);
					return;
				}
				log.detail(`cancel requested for ${message.runId}`);
				const runId = message.runId;
				void transport.cancel(runId).catch((error: unknown) => {
					log.detail(`cancel(${runId}) failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			},
			close(socket: ServerWebSocket<undefined>) {
				sockets.delete(socket);
				log.detail(`browser disconnected (${sockets.size} client(s) left)`);
			},
		},
	});

	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		if (current && !current.finished && !current.stale) {
			current.stale = true;
			current.finished = true;
			await transport.cancel(current.runId).catch(() => {});
		}
		for (const socket of sockets) socket.close();
		sockets.clear();
		await server.stop(true);
	};

	// `server.port` is undefined only for unix-socket servers, which this never is.
	return Promise.resolve({ port: server.port ?? options.port, close });
}
