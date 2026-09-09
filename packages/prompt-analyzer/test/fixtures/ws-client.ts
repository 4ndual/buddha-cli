/**
 * Tiny WebSocket client helper for server tests: connect, record every
 * `AnalysisEvent` frame in arrival order, and await specific frames.
 */
import type { AnalysisEvent } from "../../src/contracts";

export interface EventClient {
	socket: WebSocket;
	/** Every frame received, in arrival order. */
	events: AnalysisEvent[];
	send(payload: unknown): void;
	/** Resolve once a frame matching `predicate` arrives (or reject on timeout). */
	waitFor(predicate: (event: AnalysisEvent) => boolean, timeoutMs?: number): Promise<AnalysisEvent>;
	close(): Promise<void>;
}

export async function connectClient(port: number): Promise<EventClient> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const events: AnalysisEvent[] = [];
	const watchers: Array<{ predicate: (event: AnalysisEvent) => boolean; resolve: (event: AnalysisEvent) => void }> = [];

	socket.addEventListener("message", message => {
		const event = JSON.parse(String(message.data)) as AnalysisEvent;
		events.push(event);
		for (let index = watchers.length - 1; index >= 0; index--) {
			const watcher = watchers[index];
			if (watcher && watcher.predicate(event)) {
				watchers.splice(index, 1);
				watcher.resolve(event);
			}
		}
	});

	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve(), { once: true });
	socket.addEventListener("error", () => opened.reject(new Error("websocket failed to open")), { once: true });
	await opened.promise;

	return {
		socket,
		events,
		send(payload: unknown): void {
			socket.send(JSON.stringify(payload));
		},
		waitFor(predicate, timeoutMs = 5000): Promise<AnalysisEvent> {
			const existing = events.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve, reject } = Promise.withResolvers<AnalysisEvent>();
			const watcher = { predicate, resolve };
			watchers.push(watcher);
			const timer = setTimeout(() => {
				const at = watchers.indexOf(watcher);
				if (at >= 0) watchers.splice(at, 1);
				reject(new Error(`timed out waiting for a frame; saw: ${events.map(e => e.type).join(", ")}`));
			}, timeoutMs);
			return promise.finally(() => clearTimeout(timer));
		},
		close(): Promise<void> {
			if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			socket.addEventListener("close", () => resolve(), { once: true });
			socket.close();
			return promise;
		},
	};
}
