/** Hidden CLI selector used to re-enter the WCDB worker host. */
export const WCDB_WORKER_ARG = "__omp_worker_wcdb";

/**
 * SQLite INTEGER values cross the worker/native boundary as validated decimal
 * strings. JavaScript numbers are reserved for finite, safe integers and REALs;
 * a 64-bit row id or timestamp is never rounded through a Number.
 */
export interface WcdbInt64 {
	readonly type: "int64";
	readonly decimal: string;
}

/** Binary values are structured-cloned Uint8Arrays, never base64 strings. */
export type WcdbValue = null | boolean | number | string | WcdbInt64 | Uint8Array;
export type WcdbRecord = Record<string, WcdbValue>;

export interface WcdbKeyset {
	readonly values: readonly WcdbValue[];
}

export interface WcdbOpenOptions {
	readonly databasePath: string;
	readonly readPoolSize?: number;
	/** Absolute path to the pinned WCDB bridge; required only in explicit DB mode. */
	readonly nativeLibraryPath: string;
	readonly busyTimeoutMs?: number;
	readonly maxQueuedBytes?: number;
	readonly maxRequestBytes?: number;
}

export interface WcdbHealth {
	readonly available: boolean;
	readonly capability: "wcdb";
	readonly reason?: string;
	readonly schemaVersion?: number;
	readonly nativeVersion?: string;
	readonly readPoolSize: number;
	readonly queuedBytes: number;
	readonly activeReads: number;
	readonly writerActive: boolean;
	readonly accepting: boolean;
}

export type WcdbReadOperation =
	| {
			readonly kind: "list";
			readonly request: Uint8Array;
			readonly limit: number;
			readonly after?: WcdbKeyset;
	  }
	| {
			readonly kind: "search";
			readonly request: Uint8Array;
			readonly limit: number;
			readonly after?: WcdbKeyset;
	  }
	| { readonly kind: "get-header"; readonly branchId: string }
	| {
			readonly kind: "read-tree";
			readonly request: Uint8Array;
			readonly limit: number;
			readonly after?: WcdbKeyset;
	  }
	| {
			readonly kind: "read-context-tail";
			readonly request: Uint8Array;
	  }
	| {
			readonly kind: "read-payload-chunks";
			readonly request: Uint8Array;
			readonly limit: number;
			readonly afterChunk?: WcdbInt64;
	  }
	| { readonly kind: "export-page"; readonly jobId: string; readonly limit: number; readonly after?: WcdbKeyset }
	| { readonly kind: "get-transfer-job"; readonly jobId: string }
	| { readonly kind: "verify" }
	| { readonly kind: "health" };

export type WcdbWriteOperation =
	| {
			readonly kind: "append";
			readonly branchId: string;
			readonly expectedHeadHash: string | null;
			readonly events: readonly WcdbRecord[];
			readonly payloads: readonly WcdbRecord[];
	  }
	| {
			readonly kind: "fork";
			readonly request: Uint8Array;
	  }
	| {
			readonly kind: "write-checkpoint";
			readonly request: Uint8Array;
	  }
	| {
			readonly kind: "begin-import";
			readonly jobId: string;
			readonly request: Uint8Array;
	  }
	| {
			readonly kind: "import-batch";
			readonly jobId: string;
			readonly cursor: string;
			readonly chunks: readonly Uint8Array[];
			readonly final: boolean;
	  }
	| { readonly kind: "begin-export"; readonly jobId: string; readonly request: Uint8Array }
	| { readonly kind: "control-transfer-job"; readonly jobId: string; readonly control: string }
	| { readonly kind: "backup"; readonly request: Uint8Array }
	| { readonly kind: "flush"; readonly durability: "process" | "power-loss" };

export type WcdbOperation = WcdbReadOperation | WcdbWriteOperation;

export interface WcdbBatchResult {
	/** Bounded rows. Payload bodies are returned only by read-payload-chunks. */
	readonly rows: readonly WcdbRecord[];
	readonly next?: WcdbKeyset;
	/** Present for committed mutations only. */
	readonly commitSequence?: WcdbInt64;
	/** True only after the native transaction commit returned successfully. */
	readonly committed?: boolean;
	readonly health?: WcdbHealth;
}

export interface WcdbErrorPayload {
	readonly code:
		| "ABORTED"
		| "BACKPRESSURE"
		| "BUSY"
		| "CLOSED"
		| "CONFLICT"
		| "CORRUPT"
		| "INVALID"
		| "NATIVE_UNAVAILABLE"
		| "NOT_FOUND"
		| "TIMEOUT"
		| "UNKNOWN";
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: WcdbRecord;
}

export type WcdbWorkerInbound =
	| { readonly type: "open"; readonly options: WcdbOpenOptions }
	| {
			readonly type: "request";
			readonly id: string;
			readonly operation: WcdbOperation;
			/** Exact estimated structured-clone payload bytes used for queue accounting. */
			readonly inputBytes: number;
			readonly timeoutMs: number;
	  }
	| { readonly type: "cancel"; readonly id: string; readonly reason?: string }
	| { readonly type: "shutdown"; readonly drain: boolean };

export type WcdbWorkerOutbound =
	| { readonly type: "ready"; readonly health: WcdbHealth }
	| { readonly type: "open-failed"; readonly error: WcdbErrorPayload }
	| { readonly type: "result"; readonly id: string; readonly result: WcdbBatchResult }
	| { readonly type: "error"; readonly id: string; readonly error: WcdbErrorPayload }
	| { readonly type: "closed" };

export interface WcdbWorkerTransport {
	send(message: WcdbWorkerOutbound): void;
	onMessage(handler: (message: WcdbWorkerInbound) => void): () => void;
	close(): void;
}

export interface WcdbClientTransport {
	send(message: WcdbWorkerInbound): void;
	onMessage(handler: (message: WcdbWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

const INT64_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

export function int64(value: bigint | string): WcdbInt64 {
	const decimal = typeof value === "bigint" ? value.toString() : value;
	if (!INT64_PATTERN.test(decimal)) throw new TypeError(`Invalid int64 decimal: ${decimal}`);
	const parsed = BigInt(decimal);
	if (parsed < INT64_MIN || parsed > INT64_MAX) throw new RangeError(`int64 out of range: ${decimal}`);
	return { type: "int64", decimal };
}

export function bigintFromInt64(value: WcdbInt64): bigint {
	return BigInt(int64(value.decimal).decimal);
}

export function isWriteOperation(operation: WcdbOperation): operation is WcdbWriteOperation {
	switch (operation.kind) {
		case "append":
		case "fork":
		case "write-checkpoint":
		case "begin-import":
		case "import-batch":
		case "begin-export":
		case "control-transfer-job":
		case "backup":
		case "flush":
			return true;
		default:
			return false;
	}
}

/**
 * Deterministic upper-bound-ish accounting used on both sides of the worker
 * channel. Binary byte lengths are counted directly and strings as UTF-8.
 * Cycles and unsupported values are rejected before they enter the queue.
 */
export function estimateWireBytes(value: unknown): number {
	const seen = new Set<object>();
	const visit = (candidate: unknown): number => {
		if (candidate === null) return 4;
		switch (typeof candidate) {
			case "boolean":
				return candidate ? 4 : 5;
			case "number":
				if (!Number.isFinite(candidate)) throw new TypeError("WCDB protocol numbers must be finite");
				return 8;
			case "string":
				return new TextEncoder().encode(candidate).byteLength + 2;
			case "object": {
				if (candidate instanceof Uint8Array) return candidate.byteLength;
				if (seen.has(candidate)) throw new TypeError("WCDB protocol values must not contain cycles");
				seen.add(candidate);
				let bytes = 2;
				if (Array.isArray(candidate)) {
					for (const item of candidate) bytes += visit(item) + 1;
				} else {
					for (const [key, item] of Object.entries(candidate)) bytes += visit(key) + visit(item) + 1;
				}
				seen.delete(candidate);
				return bytes;
			}
			default:
				throw new TypeError(`Unsupported WCDB protocol value: ${typeof candidate}`);
		}
	};
	return visit(value);
}
