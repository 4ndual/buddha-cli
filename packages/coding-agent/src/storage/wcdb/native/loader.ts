import { CString, dlopen, FFIType, ptr, toArrayBuffer, type Library } from "bun:ffi";

import { decodeWcdbBatch, encodeWcdbBatch, type WcdbBatchRequest, type WcdbBatchResult } from "./protocol";

const EXPECTED_ABI_VERSION = 1;
const MAX_NATIVE_BUFFER_BYTES = 256 * 1024 * 1024;

const NATIVE_SYMBOLS = {
	omp_wcdb_abi_version: { args: [], returns: FFIType.u32 },
	omp_wcdb_build_id: { args: [], returns: FFIType.ptr },
	omp_wcdb_open: {
		args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr],
		returns: FFIType.i32,
	},
	omp_wcdb_batch: {
		args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u64, FFIType.ptr],
		returns: FFIType.i32,
	},
	omp_wcdb_cancel: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
	omp_wcdb_checkpoint: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	omp_wcdb_backup: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
	omp_wcdb_last_error: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	omp_wcdb_shutdown: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	omp_wcdb_free_buffer: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
} as const;

type WcdbDynamicLibrary = Library<typeof NATIVE_SYMBOLS>;

export type WcdbNativeStatus =
	| 0
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11;

const STATUS_NAMES: Record<WcdbNativeStatus, string> = {
	0: "ok",
	1: "invalid_argument",
	2: "out_of_memory",
	3: "closed",
	4: "cancelled",
	5: "timeout",
	6: "engine_error",
	7: "protocol_error",
	8: "busy",
	9: "io_error",
	10: "internal_error",
	11: "unsupported",
};

export interface WcdbNativeLoadOptions {
	libraryPath: string;
	databasePath: string;
	readOnly?: boolean;
	create?: boolean;
}

export interface WcdbNativeBatchOptions {
	timeoutMs?: number;
	cancellationToken?: bigint;
	signal?: AbortSignal;
}

export interface WcdbNativeCapabilityOptions {
	libraryPath?: string;
}

export interface WcdbNativeCapability {
	enabled: boolean;
	libraryPath: string | null;
	abiVersion: number | null;
	buildId: string | null;
	reason: string | null;
}

export interface WcdbNativeHealth {
	closed: boolean;
	abiVersion: number;
	buildId: string;
}

export interface WcdbNativeHandle {
	readonly buildId: string;
	batchEncoded(request: Uint8Array, options?: WcdbNativeBatchOptions): Uint8Array;
	executeBatch(request: WcdbBatchRequest, options?: WcdbNativeBatchOptions): WcdbBatchResult;
	cancel(token: bigint): void;
	checkpoint(mode: "passive" | "truncate"): void;
	backup(destination: string): void;
	health(): WcdbNativeHealth;
	close(timeoutMs?: number): void;
}

export class WcdbNativeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WcdbNativeUnavailableError";
	}
}

export class WcdbNativeError extends Error {
	readonly status: WcdbNativeStatus;

	constructor(status: WcdbNativeStatus, operation: string, detail?: string) {
		super(`WCDB ${operation} failed (${STATUS_NAMES[status] ?? `unknown_${status}`})${detail ? `: ${detail}` : ""}`);
		this.name = "WcdbNativeError";
		this.status = status;
	}
}

function checkedTimeout(value: number | undefined, fallback: number): number {
	const timeout = value ?? fallback;
	if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 0xffffffff) {
		throw new RangeError("WCDB timeout must be a uint32 number of milliseconds");
	}
	return timeout;
}

function checkedToken(value: bigint | undefined): bigint {
	const token = value ?? 0n;
	if (token < 0n || token > 0xffffffffffffffffn) throw new RangeError("WCDB cancellation token must be a uint64");
	return token;
}


function readBuildId(library: WcdbDynamicLibrary): string {
	const pointer = library.symbols.omp_wcdb_build_id();
	if (!pointer) throw new WcdbNativeUnavailableError("WCDB bridge returned an empty build identifier");
	return new CString(pointer).toString();
}

function readOwnedBuffer(library: WcdbDynamicLibrary, output: BigUint64Array): Uint8Array {
	const address = output[0];
	const length = Number(output[1]);
	if (address === 0n || !Number.isSafeInteger(length) || length < 0 || length > MAX_NATIVE_BUFFER_BYTES) {
		if (address !== 0n && Number.isSafeInteger(length) && length >= 0) {
			library.symbols.omp_wcdb_free_buffer(address, BigInt(length));
		}
		throw new WcdbNativeUnavailableError("WCDB returned an invalid owned buffer");
	}
	try {
		return new Uint8Array(toArrayBuffer(address, 0, length)).slice();
	} finally {
		library.symbols.omp_wcdb_free_buffer(address, BigInt(length));
	}
}

function lastError(library: WcdbDynamicLibrary, handle: bigint): string | undefined {
	const output = new BigUint64Array(2);
	const status = library.symbols.omp_wcdb_last_error(handle, ptr(output));
	if (status !== 0 || output[0] === 0n || output[1] === 0n) return undefined;
	return new TextDecoder("utf-8", { fatal: false }).decode(readOwnedBuffer(library, output));
}

function assertStatus(library: WcdbDynamicLibrary, handle: bigint, operation: string, status: number): void {
	if (status === 0) return;
	const normalized = status >= 0 && status <= 11 ? (status as WcdbNativeStatus) : 10;
	throw new WcdbNativeError(normalized, operation, handle === 0n ? undefined : lastError(library, handle));
}

function openVerifiedLibrary(libraryPath: string): { library: WcdbDynamicLibrary; abiVersion: number; buildId: string } {
	if (libraryPath.length === 0) throw new WcdbNativeUnavailableError("WCDB library path is empty");
	let library: WcdbDynamicLibrary;
	try {
		library = dlopen(libraryPath, NATIVE_SYMBOLS);
	} catch (error) {
		throw new WcdbNativeUnavailableError(`Unable to load WCDB bridge at ${libraryPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const abiVersion = library.symbols.omp_wcdb_abi_version();
		if (abiVersion !== EXPECTED_ABI_VERSION) {
			throw new WcdbNativeUnavailableError(`WCDB bridge ABI ${abiVersion} does not match required ABI ${EXPECTED_ABI_VERSION}`);
		}
		return { library, abiVersion, buildId: readBuildId(library) };
	} catch (error) {
		library.close();
		throw error;
	}
}

export function probeWcdbNativeCapability(options: WcdbNativeCapabilityOptions = {}): WcdbNativeCapability {
	const libraryPath = options.libraryPath ?? process.env.OMP_WCDB_LIBRARY ?? null;
	if (libraryPath === null) {
		return { enabled: false, libraryPath: null, abiVersion: null, buildId: null, reason: "No WCDB bridge path configured" };
	}
	try {
		const verified = openVerifiedLibrary(libraryPath);
		verified.library.close();
		return {
			enabled: true,
			libraryPath,
			abiVersion: verified.abiVersion,
			buildId: verified.buildId,
			reason: null,
		};
	} catch (error) {
		return {
			enabled: false,
			libraryPath,
			abiVersion: null,
			buildId: null,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function loadWcdbNative(options: WcdbNativeLoadOptions): WcdbNativeHandle {
	const verified = openVerifiedLibrary(options.libraryPath);
	const databasePath = new TextEncoder().encode(options.databasePath);
	if (databasePath.byteLength === 0) {
		verified.library.close();
		throw new WcdbNativeUnavailableError("WCDB database path is empty");
	}
	const output = new BigUint64Array(1);
	const flags = (options.readOnly ? 1 : 0) | (options.create === false ? 0 : 2);
	const openStatus = verified.library.symbols.omp_wcdb_open(ptr(databasePath), BigInt(databasePath.byteLength), flags, ptr(output));
	const handle = output[0];
	if (openStatus !== 0 || handle === 0n) {
		verified.library.close();
		const status = openStatus >= 0 && openStatus <= 11 ? (openStatus as WcdbNativeStatus) : 10;
		throw new WcdbNativeError(status, "open");
	}
	let closed = false;

	const requireOpen = (): void => {
		if (closed) throw new WcdbNativeError(3, "operation", "handle is closed");
	};

	const nativeHandle: WcdbNativeHandle = {
		buildId: verified.buildId,
		batchEncoded(request, batchOptions = {}) {
			requireOpen();
			if (batchOptions.signal?.aborted) throw batchOptions.signal.reason ?? new DOMException("Aborted", "AbortError");
			const timeoutMs = checkedTimeout(batchOptions.timeoutMs, 30_000);
			const token = checkedToken(batchOptions.cancellationToken);
			const response = new BigUint64Array(2);
			const status = verified.library.symbols.omp_wcdb_batch(
				handle,
				ptr(request),
				BigInt(request.byteLength),
				timeoutMs,
				token,
				ptr(response),
			);
			assertStatus(verified.library, handle, "batch", status);
			if (batchOptions.signal?.aborted) {
				const bytes = readOwnedBuffer(verified.library, response);
				void bytes;
				throw batchOptions.signal.reason ?? new DOMException("Aborted", "AbortError");
			}
			return readOwnedBuffer(verified.library, response);
		},
		executeBatch(request, batchOptions) {
			return decodeWcdbBatch(nativeHandle.batchEncoded(encodeWcdbBatch(request), batchOptions));
		},
		cancel(token) {
			requireOpen();
			assertStatus(verified.library, handle, "cancel", verified.library.symbols.omp_wcdb_cancel(handle, checkedToken(token)));
		},
		checkpoint(mode) {
			requireOpen();
			assertStatus(verified.library, handle, "checkpoint", verified.library.symbols.omp_wcdb_checkpoint(handle, mode === "truncate" ? 1 : 0));
		},
		backup(destination) {
			requireOpen();
			const path = new TextEncoder().encode(destination);
			if (path.byteLength === 0) throw new WcdbNativeError(1, "backup", "destination is empty");
			assertStatus(
				verified.library,
				handle,
				"backup",
				verified.library.symbols.omp_wcdb_backup(handle, ptr(path), BigInt(path.byteLength)),
			);
		},
		health() {
			return { closed, abiVersion: verified.abiVersion, buildId: verified.buildId };
		},
		close(timeoutMs = 5_000) {
			if (closed) return;
			assertStatus(verified.library, handle, "shutdown", verified.library.symbols.omp_wcdb_shutdown(handle, checkedTimeout(timeoutMs, 5_000)));
			closed = true;
			verified.library.close();
		},
	};
	return nativeHandle;
}
