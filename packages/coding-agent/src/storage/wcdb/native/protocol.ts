const REQUEST_MAGIC = 0x5152574f;
const RESPONSE_MAGIC = 0x5352574f;
const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_STATEMENTS = 4096;
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type WcdbValue = null | bigint | number | string | Uint8Array;

export interface WcdbBatchStatement {
	kind: "execute" | "query";
	sql: string;
	parameters?: readonly WcdbValue[];
	/** Required and positive for queries; protects the native response boundary. */
	maxRows?: number;
}

export interface WcdbBatchRequest {
	transactional: boolean;
	statements: readonly WcdbBatchStatement[];
}

export interface WcdbBatchStatementResult {
	affectedRows: bigint;
	lastInsertRowId: bigint;
	columns: readonly string[];
	rows: readonly (readonly WcdbValue[])[];
}

export interface WcdbBatchResult {
	statements: readonly WcdbBatchStatementResult[];
}

class FrameWriter {
	readonly #view: DataView;
	readonly #bytes: Uint8Array;
	#offset = 0;

	constructor(length: number) {
		if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
			throw new RangeError(`WCDB frame length ${length} is outside the supported range`);
		}
		this.#bytes = new Uint8Array(length);
		this.#view = new DataView(this.#bytes.buffer);
	}

	u8(value: number): void {
		this.#view.setUint8(this.#offset, value);
		this.#offset += 1;
	}

	u16(value: number): void {
		this.#view.setUint16(this.#offset, value, true);
		this.#offset += 2;
	}

	u32(value: number): void {
		this.#view.setUint32(this.#offset, value, true);
		this.#offset += 4;
	}

	i64(value: bigint): void {
		if (value < MIN_I64 || value > MAX_I64) {
			throw new WcdbProtocolError(`WCDB integer ${value} is outside the signed 64-bit range`);
		}
		this.#view.setBigInt64(this.#offset, value, true);
		this.#offset += 8;
	}

	f64(value: number): void {
		this.#view.setFloat64(this.#offset, value, true);
		this.#offset += 8;
	}

	raw(value: Uint8Array): void {
		this.#bytes.set(value, this.#offset);
		this.#offset += value.byteLength;
	}

	sized(value: Uint8Array): void {
		this.u32(value.byteLength);
		this.raw(value);
	}

	finish(): Uint8Array {
		if (this.#offset !== this.#bytes.byteLength) {
			throw new Error(`WCDB frame size mismatch: wrote ${this.#offset} of ${this.#bytes.byteLength} bytes`);
		}
		return this.#bytes;
	}
}

class FrameReader {
	readonly #view: DataView;
	readonly #bytes: Uint8Array;
	#offset = 0;

	constructor(bytes: Uint8Array) {
		if (bytes.byteLength > MAX_FRAME_BYTES) throw new RangeError("WCDB response exceeds the frame limit");
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	#require(length: number): void {
		if (length < 0 || this.#offset + length > this.#bytes.byteLength) {
			throw new WcdbProtocolError("Truncated WCDB response frame");
		}
	}

	u8(): number {
		this.#require(1);
		const value = this.#view.getUint8(this.#offset);
		this.#offset += 1;
		return value;
	}

	u16(): number {
		this.#require(2);
		const value = this.#view.getUint16(this.#offset, true);
		this.#offset += 2;
		return value;
	}

	u32(): number {
		this.#require(4);
		const value = this.#view.getUint32(this.#offset, true);
		this.#offset += 4;
		return value;
	}

	i64(): bigint {
		this.#require(8);
		const value = this.#view.getBigInt64(this.#offset, true);
		this.#offset += 8;
		return value;
	}

	f64(): number {
		this.#require(8);
		const value = this.#view.getFloat64(this.#offset, true);
		this.#offset += 8;
		return value;
	}

	sized(): Uint8Array {
		const length = this.u32();
		this.#require(length);
		const value = this.#bytes.subarray(this.#offset, this.#offset + length);
		this.#offset += length;
		return value;
	}

	finish(): void {
		if (this.#offset !== this.#bytes.byteLength) throw new WcdbProtocolError("Trailing bytes in WCDB response frame");
	}
}

export class WcdbProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WcdbProtocolError";
	}
}

function encodedValueLength(value: WcdbValue): number {
	if (value === null) return 1;
	if (typeof value === "bigint" || typeof value === "number") return 9;
	if (typeof value === "string") {
		if (value.includes("\0")) throw new WcdbProtocolError("WCDB text parameters cannot contain NUL; use a binary value instead");
		return 5 + textEncoder.encode(value).byteLength;
	}
	return 5 + value.byteLength;
}

function writeValue(writer: FrameWriter, value: WcdbValue): void {
	if (value === null) {
		writer.u8(0);
	} else if (typeof value === "bigint") {
		writer.u8(1);
		writer.i64(value);
	} else if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new WcdbProtocolError("WCDB floating-point parameters must be finite");
		writer.u8(2);
		writer.f64(value);
	} else if (typeof value === "string") {
		writer.u8(3);
		writer.sized(textEncoder.encode(value));
	} else {
		writer.u8(4);
		writer.sized(value);
	}
}

function readValue(reader: FrameReader): WcdbValue {
	switch (reader.u8()) {
		case 0:
			return null;
		case 1:
			return reader.i64();
		case 2:
			return reader.f64();
		case 3:
			try {
				return textDecoder.decode(reader.sized());
			} catch (error) {
				throw new WcdbProtocolError(`WCDB returned invalid UTF-8 text: ${error instanceof Error ? error.message : String(error)}`);
			}
		case 4:
			return new Uint8Array(reader.sized());
		default:
			throw new WcdbProtocolError("WCDB returned an unknown value tag");
	}
}

export function encodeWcdbBatch(request: WcdbBatchRequest): Uint8Array {
	if (request.statements.length > MAX_STATEMENTS) throw new RangeError("WCDB batch has too many statements");
	let length = 12;
	const prepared = request.statements.map((statement) => {
		if (statement.sql.length === 0 || statement.sql.includes("\0")) throw new WcdbProtocolError("WCDB SQL must be non-empty UTF-8 without NUL");
		const sql = textEncoder.encode(statement.sql);
		const parameters = statement.parameters ?? [];
		const maxRows = statement.kind === "query" ? statement.maxRows : 0;
		if (statement.kind === "query" && (!Number.isInteger(maxRows) || (maxRows ?? 0) <= 0 || (maxRows ?? 0) > 0xffffffff)) {
			throw new WcdbProtocolError("WCDB queries require a positive uint32 maxRows limit");
		}
		length += 16 + sql.byteLength;
		for (const parameter of parameters) length += encodedValueLength(parameter);
		return { statement, sql, parameters, maxRows: maxRows ?? 0 };
	});
	const writer = new FrameWriter(length);
	writer.u32(REQUEST_MAGIC);
	writer.u16(PROTOCOL_VERSION);
	writer.u16(request.transactional ? 1 : 0);
	writer.u32(prepared.length);
	for (const { statement, sql, parameters, maxRows } of prepared) {
		writer.u8(statement.kind === "execute" ? 1 : 2);
		writer.u8(0);
		writer.u16(0);
		writer.u32(maxRows);
		writer.sized(sql);
		writer.u32(parameters.length);
		for (const parameter of parameters) writeValue(writer, parameter);
	}
	return writer.finish();
}

export function decodeWcdbBatch(bytes: Uint8Array): WcdbBatchResult {
	const reader = new FrameReader(bytes);
	if (reader.u32() !== RESPONSE_MAGIC || reader.u16() !== PROTOCOL_VERSION) {
		throw new WcdbProtocolError("Unsupported WCDB response header");
	}
	const status = reader.u16();
	if (status !== 0) throw new WcdbProtocolError(`WCDB response embedded unexpected status ${status}`);
	const statementCount = reader.u32();
	if (statementCount > MAX_STATEMENTS) throw new WcdbProtocolError("WCDB response has too many statements");
	const statements: WcdbBatchStatementResult[] = [];
	for (let statementIndex = 0; statementIndex < statementCount; statementIndex++) {
		const affectedRows = reader.i64();
		const lastInsertRowId = reader.i64();
		const columnCount = reader.u32();
		if (columnCount > 4096) throw new WcdbProtocolError("WCDB response has too many columns");
		const columns: string[] = [];
		for (let column = 0; column < columnCount; column++) columns.push(textDecoder.decode(reader.sized()));
		const rowCount = reader.u32();
		const rows: WcdbValue[][] = [];
		for (let row = 0; row < rowCount; row++) {
			const values: WcdbValue[] = [];
			for (let column = 0; column < columnCount; column++) values.push(readValue(reader));
			rows.push(values);
		}
		statements.push({ affectedRows, lastInsertRowId, columns, rows });
	}
	reader.finish();
	return { statements };
}
