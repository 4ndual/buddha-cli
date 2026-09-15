export interface WriterQueueStats {
	readonly maxBytes: number;
	readonly usedBytes: number;
	readonly queuedTasks: number;
	readonly waitingProducers: number;
	readonly running: boolean;
	readonly closed: boolean;
	readonly completedTasks: number;
	readonly failedTasks: number;
	readonly lastError?: unknown;
}

export interface EnqueueOptions {
	signal?: AbortSignal;
}

interface QueuedTask<T> {
	bytes: number;
	run: (signal: AbortSignal | undefined) => Promise<T> | T;
	signal: AbortSignal | undefined;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

interface CapacityWaiter {
	bytes: number;
	signal: AbortSignal | undefined;
	resolve: () => void;
	reject: (reason?: unknown) => void;
	onAbort?: () => void;
}

/**
 * A single-consumer queue whose bound covers both queued and currently running
 * input buffers. Producers wait FIFO for byte capacity instead of allowing the
 * JS heap to grow with an unbounded promise queue.
 */
export class ByteBoundedWriterQueue {
	readonly #maxBytes: number;
	readonly #tasks: QueuedTask<unknown>[] = [];
	readonly #waiters: CapacityWaiter[] = [];
	readonly #idleWaiters = new Set<() => void>();
	#usedBytes = 0;
	#running = false;
	#closed = false;
	#completedTasks = 0;
	#failedTasks = 0;
	#lastError: unknown;

	constructor(maxBytes: number) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
			throw new RangeError("writer queue maxBytes must be a positive integer");
		}
		this.#maxBytes = maxBytes;
	}

	get stats(): WriterQueueStats {
		return Object.freeze({
			maxBytes: this.#maxBytes,
			usedBytes: this.#usedBytes,
			queuedTasks: this.#tasks.length,
			waitingProducers: this.#waiters.length,
			running: this.#running,
			closed: this.#closed,
			completedTasks: this.#completedTasks,
			failedTasks: this.#failedTasks,
			lastError: this.#lastError,
		});
	}

	async enqueue<T>(
		bytes: number,
		run: (signal: AbortSignal | undefined) => Promise<T> | T,
		options: EnqueueOptions = {},
	): Promise<T> {
		this.#assertAccepting(bytes, options.signal);
		await this.#acquire(bytes, options.signal);

		if (this.#closed || options.signal?.aborted) {
			this.#release(bytes);
			if (options.signal?.aborted) throw abortReason(options.signal);
			throw new Error("writer queue is closed");
		}

		return new Promise<T>((resolve, reject) => {
			this.#tasks.push({ bytes, run, signal: options.signal, resolve, reject } as QueuedTask<unknown>);
			this.#startPump();
		});
	}

	/** Resolves when accepted and capacity-waiting work has settled. */
	async flush(): Promise<void> {
		if (this.#isIdle()) return;
		await new Promise<void>(resolve => this.#idleWaiters.add(resolve));
	}

	/** Rejects producers still waiting for capacity, then drains accepted work. */
	async close(): Promise<void> {
		if (this.#closed) return this.flush();
		this.#closed = true;
		const error = new Error("writer queue is closed");
		for (const waiter of this.#waiters.splice(0)) {
			this.#detachAbort(waiter);
			waiter.reject(error);
		}
		this.#notifyIdle();
		await this.flush();
	}

	#assertAccepting(bytes: number, signal: AbortSignal | undefined): void {
		if (this.#closed) throw new Error("writer queue is closed");
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("queued byte size must be a non-negative integer");
		if (bytes > this.#maxBytes) {
			throw new RangeError(`write batch is ${bytes} bytes, exceeding the ${this.#maxBytes}-byte queue limit`);
		}
		if (signal?.aborted) throw abortReason(signal);
	}

	#acquire(bytes: number, signal: AbortSignal | undefined): Promise<void> {
		if (this.#waiters.length === 0 && this.#usedBytes + bytes <= this.#maxBytes) {
			this.#usedBytes += bytes;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: CapacityWaiter = { bytes, signal, resolve, reject };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.#waiters.indexOf(waiter);
					if (index >= 0) this.#waiters.splice(index, 1);
					this.#detachAbort(waiter);
					reject(abortReason(signal));
					this.#wakeCapacityWaiters();
					this.#notifyIdle();
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.#waiters.push(waiter);
		});
	}

	#startPump(): void {
		if (this.#running) return;
		this.#running = true;
		queueMicrotask(() => void this.#pump());
	}

	async #pump(): Promise<void> {
		while (this.#tasks.length > 0) {
			const task = this.#tasks.shift()!;
			try {
				if (task.signal?.aborted) throw abortReason(task.signal);
				const result = await task.run(task.signal);
				this.#completedTasks += 1;
				task.resolve(result);
			} catch (error) {
				this.#failedTasks += 1;
				this.#lastError = error;
				task.reject(error);
			} finally {
				this.#release(task.bytes);
			}
		}
		this.#running = false;
		// A producer can enqueue between the final shift and clearing #running.
		if (this.#tasks.length > 0) this.#startPump();
		this.#notifyIdle();
	}

	#release(bytes: number): void {
		this.#usedBytes -= bytes;
		if (this.#usedBytes < 0) throw new Error("writer queue byte accounting underflow");
		this.#wakeCapacityWaiters();
		this.#notifyIdle();
	}

	#wakeCapacityWaiters(): void {
		while (!this.#closed && this.#waiters.length > 0) {
			const waiter = this.#waiters[0];
			if (waiter.signal?.aborted) {
				this.#waiters.shift();
				this.#detachAbort(waiter);
				waiter.reject(abortReason(waiter.signal));
				continue;
			}
			if (this.#usedBytes + waiter.bytes > this.#maxBytes) return;
			this.#waiters.shift();
			this.#detachAbort(waiter);
			this.#usedBytes += waiter.bytes;
			waiter.resolve();
		}
	}

	#detachAbort(waiter: CapacityWaiter): void {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}

	#isIdle(): boolean {
		return !this.#running && this.#tasks.length === 0 && this.#waiters.length === 0 && this.#usedBytes === 0;
	}

	#notifyIdle(): void {
		if (!this.#isIdle()) return;
		for (const resolve of this.#idleWaiters) resolve();
		this.#idleWaiters.clear();
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
