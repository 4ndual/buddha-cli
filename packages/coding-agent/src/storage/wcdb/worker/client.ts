import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import {
	estimateWireBytes,
	WCDB_WORKER_ARG,
	type WcdbBatchResult,
	type WcdbClientTransport,
	type WcdbErrorPayload,
	type WcdbHealth,
	type WcdbOpenOptions,
	type WcdbOperation,
	type WcdbWorkerInbound,
	type WcdbWorkerOutbound,
} from "./protocol";

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_CLIENT_QUEUED_BYTES = 16 * 1024 * 1024;

export class WcdbWorkerError extends Error {
	readonly code: WcdbErrorPayload["code"];
	readonly retryable: boolean;
	readonly details?: WcdbErrorPayload["details"];

	constructor(payload: WcdbErrorPayload) {
		super(payload.message);
		this.name = "WcdbWorkerError";
		this.code = payload.code;
		this.retryable = payload.retryable;
		this.details = payload.details;
	}
}

export interface WcdbRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface WcdbWorkerClientOptions {
	readonly transport?: WcdbClientTransport;
	readonly openTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
}

interface PendingRequest {
	readonly resolve: (result: WcdbBatchResult) => void;
	readonly reject: (error: Error) => void;
	readonly releaseBytes: () => void;
	readonly timeout: ReturnType<typeof setTimeout>;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
}

interface ByteWaiter {
	readonly bytes: number;
	readonly resolve: (release: () => void) => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
}

class ByteBudget {
	readonly #capacity: number;
	#used = 0;
	#waiters: ByteWaiter[] = [];

	constructor(capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("WCDB byte budget must be a positive safe integer");
		this.#capacity = capacity;
	}

	acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
		if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new RangeError("Invalid WCDB request byte size"));
		if (bytes > this.#capacity) {
			return Promise.reject(
				new WcdbWorkerError({
					code: "BACKPRESSURE",
					message: `WCDB request is ${bytes} bytes; client budget is ${this.#capacity}. Stream it in smaller batches.`,
					retryable: false,
				}),
			);
		}
		if (signal?.aborted) return Promise.reject(this.#abortError(signal.reason));
		if (this.#waiters.length === 0 && this.#used + bytes <= this.#capacity) return Promise.resolve(this.#reserve(bytes));

		const { promise, resolve, reject } = Promise.withResolvers<() => void>();
		const waiter: ByteWaiter = { bytes, resolve, reject, signal };
		if (signal) {
			const onAbort = (): void => {
				const index = this.#waiters.indexOf(waiter);
				if (index >= 0) this.#waiters.splice(index, 1);
				reject(this.#abortError(signal.reason));
			};
			waiter.onAbort = onAbort;
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#waiters.push(waiter);
		return promise;
	}

	#reserve(bytes: number): () => void {
		this.#used += bytes;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#used -= bytes;
			this.#pump();
		};
	}

	#pump(): void {
		while (this.#waiters.length > 0) {
			const next = this.#waiters[0];
			if (this.#used + next.bytes > this.#capacity) return;
			this.#waiters.shift();
			if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
			next.resolve(this.#reserve(next.bytes));
		}
	}

	#abortError(reason: unknown): Error {
		return new WcdbWorkerError({
			code: "ABORTED",
			message: typeof reason === "string" ? reason : "WCDB request cancelled before admission",
			retryable: false,
		});
	}
}

/**
 * RPC client for the dedicated WCDB worker. Construction is inert; `open()` is
 * the only path that spawns a worker, which keeps JSONL startup independent of
 * native WCDB modules.
 */
export class WcdbWorkerClient {
	readonly #transport: WcdbClientTransport;
	readonly #budget: ByteBudget;
	readonly #shutdownTimeoutMs: number;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #unsubscribeMessage: () => void;
	readonly #unsubscribeError: () => void;
	#sequence = 0;
	#health: WcdbHealth;
	#closed = false;

	private constructor(
		transport: WcdbClientTransport,
		health: WcdbHealth,
		budgetBytes: number,
		shutdownTimeoutMs: number,
	) {
		this.#transport = transport;
		this.#health = health;
		this.#budget = new ByteBudget(budgetBytes);
		this.#shutdownTimeoutMs = shutdownTimeoutMs;
		this.#unsubscribeMessage = transport.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = transport.onError(error => this.#failAll(error));
	}

	static async open(options: WcdbOpenOptions, clientOptions: WcdbWorkerClientOptions = {}): Promise<WcdbWorkerClient> {
		const transport = clientOptions.transport ?? spawnWcdbWorkerTransport();
		const { promise, resolve, reject } = Promise.withResolvers<WcdbHealth>();
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribeMessage();
			unsubscribeError();
			callback();
		};
		const unsubscribeMessage = transport.onMessage(message => {
			if (message.type === "ready") finish(() => resolve(message.health));
			else if (message.type === "open-failed") finish(() => reject(new WcdbWorkerError(message.error)));
		});
		const unsubscribeError = transport.onError(error => finish(() => reject(error)));
		const timeout = setTimeout(
			() =>
				finish(() =>
					reject(
						new WcdbWorkerError({ code: "TIMEOUT", message: "Timed out opening WCDB worker", retryable: true }),
					),
				),
			clientOptions.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
		);
		transport.send({ type: "open", options });
		try {
			const health = await promise;
			return new WcdbWorkerClient(
				transport,
				health,
				options.maxQueuedBytes ?? DEFAULT_CLIENT_QUEUED_BYTES,
				clientOptions.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
			);
		} catch (error) {
			await transport.terminate();
			throw error;
		}
	}

	get healthSnapshot(): WcdbHealth {
		return this.#health;
	}

	async execute(operation: WcdbOperation, options: WcdbRequestOptions = {}): Promise<WcdbBatchResult> {
		if (this.#closed) throw new WcdbWorkerError({ code: "CLOSED", message: "WCDB client is closed", retryable: false });
		const startedAt = Date.now();
		const timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("WCDB timeout must be a positive safe integer");
		const bytes = estimateWireBytes(operation);
		const admissionTimeout = AbortSignal.timeout(timeoutMs);
		const combinedSignal = options.signal ? AbortSignal.any([options.signal, admissionTimeout]) : admissionTimeout;
		const releaseBytes = await this.#budget.acquire(bytes, combinedSignal);
		const elapsed = Date.now() - startedAt;
		const remaining = Math.max(1, timeoutMs - elapsed);
		if (options.signal?.aborted) {
			releaseBytes();
			throw new WcdbWorkerError({ code: "ABORTED", message: String(options.signal.reason ?? "WCDB request cancelled"), retryable: false });
		}

		const id = `${++this.#sequence}`;
		const { promise, resolve, reject } = Promise.withResolvers<WcdbBatchResult>();
		const onAbort = options.signal
			? (): void => this.#transport.send({ type: "cancel", id, reason: String(options.signal?.reason ?? "cancelled") })
			: undefined;
		if (options.signal && onAbort) options.signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => {
			this.#transport.send({ type: "cancel", id, reason: "client timeout" });
			this.#settle(
				id,
				undefined,
				new WcdbWorkerError({ code: "TIMEOUT", message: `WCDB request ${id} timed out`, retryable: true }),
			);
		}, remaining);
		this.#pending.set(id, { resolve, reject, releaseBytes, timeout, signal: options.signal, onAbort });
		this.#transport.send({ type: "request", id, operation, inputBytes: bytes, timeoutMs: remaining });
		return await promise;
	}

	async close(options: { drain?: boolean } = {}): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		};
		const unsubscribe = this.#transport.onMessage(message => {
			if (message.type === "closed") finish();
		});
		const timeout = setTimeout(finish, this.#shutdownTimeoutMs);
		this.#transport.send({ type: "shutdown", drain: options.drain !== false });
		await promise;
		this.#unsubscribeMessage();
		this.#unsubscribeError();
		this.#failAll(new WcdbWorkerError({ code: "CLOSED", message: "WCDB client closed", retryable: false }));
		await this.#transport.terminate();
	}

	#handleMessage(message: WcdbWorkerOutbound): void {
		if (message.type === "result") this.#settle(message.id, message.result);
		else if (message.type === "error") this.#settle(message.id, undefined, new WcdbWorkerError(message.error));
		else if (message.type === "ready") this.#health = message.health;
	}

	#settle(id: string, result?: WcdbBatchResult, error?: Error): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timeout);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		pending.releaseBytes();
		if (error) pending.reject(error);
		else if (result) pending.resolve(result);
		else pending.reject(new Error("WCDB request settled without a result"));
	}

	#failAll(error: Error): void {
		for (const id of [...this.#pending.keys()]) this.#settle(id, undefined, error);
	}
}

export function spawnWcdbWorkerTransport(): WcdbClientTransport {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [WCDB_WORKER_ARG] })
		: new Worker(new URL("./entry.ts", import.meta.url).href, { type: "module" });
	return {
		send(message: WcdbWorkerInbound) {
			worker.postMessage(message);
		},
		onMessage(handler) {
			const listener = (event: MessageEvent): void => handler(event.data as WcdbWorkerOutbound);
			worker.addEventListener("message", listener);
			return () => worker.removeEventListener("message", listener);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(event.error instanceof Error ? event.error : new Error(event.message));
			const onMessageError = (): void => handler(new Error("WCDB worker message could not be decoded"));
			const onClose = (): void => handler(new Error("WCDB worker exited"));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			worker.addEventListener("close", onClose);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
				worker.removeEventListener("close", onClose);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}
