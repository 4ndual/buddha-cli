import {
	estimateWireBytes,
	isWriteOperation,
	type WcdbBatchResult,
	type WcdbErrorPayload,
	type WcdbHealth,
	type WcdbOpenOptions,
	type WcdbOperation,
	type WcdbWorkerInbound,
	type WcdbWorkerOutbound,
	type WcdbWorkerTransport,
} from "./protocol";

const DEFAULT_READ_POOL_SIZE = 2;
const MAX_READ_POOL_SIZE = 8;
const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const KNOWN_ERROR_CODES: Readonly<Record<WcdbErrorPayload["code"], true>> = {
	ABORTED: true,
	BACKPRESSURE: true,
	BUSY: true,
	CLOSED: true,
	CONFLICT: true,
	CORRUPT: true,
	INVALID: true,
	NATIVE_UNAVAILABLE: true,
	NOT_FOUND: true,
	TIMEOUT: true,
	UNKNOWN: true,
};
const MAX_PAGE_ROWS = 1_000;

export interface WcdbNativeBatchAdapter {
	executeBatch(operation: WcdbOperation, options: { signal: AbortSignal; timeoutMs: number }): Promise<WcdbBatchResult>;
	health(): Promise<Pick<WcdbHealth, "available" | "schemaVersion" | "nativeVersion" | "reason">>;
	close(): Promise<void>;
}

export type WcdbNativeAdapterFactory = (options: WcdbOpenOptions) => Promise<WcdbNativeBatchAdapter>;

interface QueuedRequest {
	readonly id: string;
	readonly operation: WcdbOperation;
	readonly inputBytes: number;
	readonly timeoutMs: number;
	readonly controller: AbortController;
	readonly timeout: ReturnType<typeof setTimeout>;
	state: "queued" | "active" | "settled";
}

interface CodedError {
	code?: unknown;
	message?: unknown;
	retryable?: unknown;
	details?: unknown;
}

function errorPayload(error: unknown, fallback: WcdbErrorPayload["code"] = "UNKNOWN"): WcdbErrorPayload {
	const coded = error !== null && typeof error === "object" ? (error as CodedError) : undefined;
	const candidate = coded?.code;
	const code =
		typeof candidate === "string" && candidate in KNOWN_ERROR_CODES
			? (candidate as WcdbErrorPayload["code"])
			: fallback;
	const message = error instanceof Error ? error.message : typeof coded?.message === "string" ? coded.message : String(error);
	const details = coded?.details;
	return {
		code,
		message,
		retryable: typeof coded?.retryable === "boolean" ? coded.retryable : code === "BUSY" || code === "TIMEOUT",
		...(details && typeof details === "object" ? { details: details as WcdbErrorPayload["details"] } : {}),
	};
}

function validateOperation(operation: WcdbOperation): void {
	if ("limit" in operation && (!Number.isSafeInteger(operation.limit) || operation.limit < 1 || operation.limit > MAX_PAGE_ROWS)) {
		throw Object.assign(new Error(`WCDB page limit must be between 1 and ${MAX_PAGE_ROWS}`), { code: "INVALID" });
	}
	if (operation.kind === "append" && operation.events.length === 0) {
		throw Object.assign(new Error("WCDB append batch must contain at least one event"), { code: "INVALID" });
	}
}

/**
 * Owns the WCDB handle for one worker. Writes are serialized, reads use a
 * bounded pool, and both queues share a byte budget. The server never reports a
 * write result until the adapter confirms its transaction committed.
 */
export class WcdbWorkerServer {
	readonly #transport: WcdbWorkerTransport;
	readonly #adapterFactory: WcdbNativeAdapterFactory;
	readonly #unsubscribe: () => void;
	#adapter: WcdbNativeBatchAdapter | undefined;
	#opening = false;
	#accepting = false;
	#closing = false;
	#readPoolSize = DEFAULT_READ_POOL_SIZE;
	#maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES;
	#maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES;
	#queuedBytes = 0;
	#activeReads = 0;
	#writerActive = false;
	#readQueue: QueuedRequest[] = [];
	#writeQueue: QueuedRequest[] = [];
	#active = new Map<string, QueuedRequest>();

	constructor(transport: WcdbWorkerTransport, adapterFactory: WcdbNativeAdapterFactory) {
		this.#transport = transport;
		this.#adapterFactory = adapterFactory;
		this.#unsubscribe = transport.onMessage(message => {
			void this.#handle(message);
		});
	}

	async #handle(message: WcdbWorkerInbound): Promise<void> {
		switch (message.type) {
			case "open":
				await this.#open(message.options);
				return;
			case "request":
				this.#enqueue(message);
				return;
			case "cancel":
				this.#cancel(message.id, message.reason);
				return;
			case "shutdown":
				this.#beginShutdown(message.drain);
				return;
		}
	}

	async #open(options: WcdbOpenOptions): Promise<void> {
		if (this.#opening || this.#adapter || this.#closing) {
			this.#transport.send({
				type: "open-failed",
				error: { code: "INVALID", message: "WCDB worker may be opened exactly once", retryable: false },
			});
			return;
		}
		this.#opening = true;
		this.#readPoolSize = Math.max(1, Math.min(options.readPoolSize ?? DEFAULT_READ_POOL_SIZE, MAX_READ_POOL_SIZE));
		this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
		this.#maxRequestBytes = options.maxRequestBytes ?? Math.min(DEFAULT_MAX_REQUEST_BYTES, this.#maxQueuedBytes);
		try {
			if (!Number.isSafeInteger(this.#maxQueuedBytes) || this.#maxQueuedBytes < 1) {
				throw Object.assign(new Error("Invalid maxQueuedBytes"), { code: "INVALID" });
			}
			if (!Number.isSafeInteger(this.#maxRequestBytes) || this.#maxRequestBytes < 1) {
				throw Object.assign(new Error("Invalid maxRequestBytes"), { code: "INVALID" });
			}
			if (this.#maxRequestBytes > this.#maxQueuedBytes) {
				throw Object.assign(new Error("maxRequestBytes exceeds maxQueuedBytes"), { code: "INVALID" });
			}
			this.#adapter = await this.#adapterFactory(options);
			const nativeHealth = await this.#adapter.health();
			if (!nativeHealth.available) throw Object.assign(new Error(nativeHealth.reason ?? "WCDB unavailable"), { code: "NATIVE_UNAVAILABLE" });
			this.#accepting = true;
			this.#transport.send({ type: "ready", health: this.#health(nativeHealth) });
		} catch (error) {
			this.#transport.send({ type: "open-failed", error: errorPayload(error, "NATIVE_UNAVAILABLE") });
			if (this.#adapter) await this.#adapter.close().catch(() => undefined);
			this.#adapter = undefined;
		} finally {
			this.#opening = false;
		}
	}

	#enqueue(message: Extract<WcdbWorkerInbound, { type: "request" }>): void {
		if (!this.#accepting || !this.#adapter) {
			this.#sendError(message.id, { code: "CLOSED", message: "WCDB worker is not accepting requests", retryable: false });
			return;
		}
		if (this.#active.has(message.id) || this.#readQueue.some(item => item.id === message.id) || this.#writeQueue.some(item => item.id === message.id)) {
			this.#sendError(message.id, { code: "INVALID", message: `Duplicate WCDB request id: ${message.id}`, retryable: false });
			return;
		}
		try {
			validateOperation(message.operation);
			if (!Number.isSafeInteger(message.timeoutMs) || message.timeoutMs < 1) throw new Error("Invalid WCDB request timeout");
			const actualBytes = estimateWireBytes(message.operation);
			if (message.inputBytes !== actualBytes) throw new Error(`WCDB byte accounting mismatch: declared ${message.inputBytes}, actual ${actualBytes}`);
			if (actualBytes > this.#maxRequestBytes) {
				this.#sendError(message.id, {
					code: "BACKPRESSURE",
					message: `WCDB request is ${actualBytes} bytes; maximum is ${this.#maxRequestBytes}. Stream it in smaller batches.`,
					retryable: false,
				});
				return;
			}
			if (this.#queuedBytes + actualBytes > this.#maxQueuedBytes) {
				this.#sendError(message.id, {
					code: "BACKPRESSURE",
					message: `WCDB worker queue byte budget exhausted (${this.#maxQueuedBytes})`,
					retryable: true,
				});
				return;
			}
			const controller = new AbortController();
			const request: QueuedRequest = {
				id: message.id,
				operation: message.operation,
				inputBytes: actualBytes,
				timeoutMs: message.timeoutMs,
				controller,
				timeout: setTimeout(() => this.#timeout(message.id), message.timeoutMs),
				state: "queued",
			};
			this.#queuedBytes += actualBytes;
			if (isWriteOperation(message.operation)) this.#writeQueue.push(request);
			else this.#readQueue.push(request);
			this.#pump();
		} catch (error) {
			this.#sendError(message.id, errorPayload(error, "INVALID"));
		}
	}

	#pump(): void {
		if (!this.#adapter) return;
		if (!this.#writerActive) {
			const write = this.#writeQueue.shift();
			if (write) {
				this.#writerActive = true;
				this.#start(write, true);
			}
		}
		// A queued foreground write gets admission before more read work. Once it
		// is active, WAL readers may proceed up to the configured bound.
		if (this.#writeQueue.length === 0) {
			while (this.#activeReads < this.#readPoolSize) {
				const read = this.#readQueue.shift();
				if (!read) break;
				this.#activeReads++;
				this.#start(read, false);
			}
		}
		this.#finishShutdownIfIdle();
	}

	#start(request: QueuedRequest, writer: boolean): void {
		const adapter = this.#adapter;
		if (!adapter) return;
		request.state = "active";
		this.#active.set(request.id, request);
		void adapter
			.executeBatch(request.operation, { signal: request.controller.signal, timeoutMs: request.timeoutMs })
			.then(result => {
				if (request.state === "settled") return;
				if (writer && (!result.committed || !result.commitSequence)) {
					throw Object.assign(new Error("WCDB native write returned before durable commit acknowledgement"), {
						code: "CORRUPT",
					});
				}
				request.state = "settled";
				this.#transport.send({ type: "result", id: request.id, result });
			})
			.catch(error => {
				if (request.state === "settled") return;
				request.state = "settled";
				const fallback = request.controller.signal.aborted ? "ABORTED" : "UNKNOWN";
				this.#sendError(request.id, errorPayload(error, fallback));
			})
			.finally(() => {
				clearTimeout(request.timeout);
				this.#active.delete(request.id);
				this.#queuedBytes -= request.inputBytes;
				if (writer) this.#writerActive = false;
				else this.#activeReads--;
				this.#pump();
			});
	}

	#timeout(id: string): void {
		const queued = this.#takeQueued(id);
		if (queued) {
			queued.state = "settled";
			clearTimeout(queued.timeout);
			this.#queuedBytes -= queued.inputBytes;
			this.#sendError(id, { code: "TIMEOUT", message: `WCDB request ${id} timed out before execution`, retryable: true });
			this.#pump();
			return;
		}
		const active = this.#active.get(id);
		if (!active || active.state === "settled") return;
		active.controller.abort(`WCDB request ${id} timed out`);
	}

	#cancel(id: string, reason?: string): void {
		const queued = this.#takeQueued(id);
		if (queued) {
			queued.state = "settled";
			clearTimeout(queued.timeout);
			this.#queuedBytes -= queued.inputBytes;
			this.#sendError(id, { code: "ABORTED", message: reason ?? `WCDB request ${id} cancelled`, retryable: false });
			this.#pump();
			return;
		}
		this.#active.get(id)?.controller.abort(reason ?? `WCDB request ${id} cancelled`);
	}

	#takeQueued(id: string): QueuedRequest | undefined {
		const readIndex = this.#readQueue.findIndex(item => item.id === id);
		if (readIndex >= 0) return this.#readQueue.splice(readIndex, 1)[0];
		const writeIndex = this.#writeQueue.findIndex(item => item.id === id);
		if (writeIndex >= 0) return this.#writeQueue.splice(writeIndex, 1)[0];
		return undefined;
	}

	#beginShutdown(drain: boolean): void {
		if (this.#closing) return;
		this.#accepting = false;
		this.#closing = true;
		if (!drain) {
			for (const queued of [...this.#readQueue, ...this.#writeQueue]) {
				queued.state = "settled";
				clearTimeout(queued.timeout);
				this.#queuedBytes -= queued.inputBytes;
				this.#sendError(queued.id, { code: "ABORTED", message: "WCDB worker shutting down", retryable: true });
			}
			this.#readQueue = [];
			this.#writeQueue = [];
			for (const active of this.#active.values()) active.controller.abort("WCDB worker shutting down");
		}
		this.#finishShutdownIfIdle();
	}

	#finishShutdownIfIdle(): void {
		if (!this.#closing || this.#active.size > 0 || this.#readQueue.length > 0 || this.#writeQueue.length > 0) return;
		const adapter = this.#adapter;
		this.#adapter = undefined;
		void (adapter?.close() ?? Promise.resolve()).finally(() => {
			this.#unsubscribe();
			this.#transport.send({ type: "closed" });
			this.#transport.close();
		});
	}

	#health(native: Pick<WcdbHealth, "available" | "schemaVersion" | "nativeVersion" | "reason">): WcdbHealth {
		return {
			...native,
			capability: "wcdb",
			readPoolSize: this.#readPoolSize,
			queuedBytes: this.#queuedBytes,
			activeReads: this.#activeReads,
			writerActive: this.#writerActive,
			accepting: this.#accepting,
		};
	}

	#sendError(id: string, error: WcdbErrorPayload): void {
		const message: WcdbWorkerOutbound = { type: "error", id, error };
		this.#transport.send(message);
	}
}
