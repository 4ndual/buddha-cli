const encoder = new TextEncoder();

export const CANONICAL_SERIALIZATION_VERSION = 1 as const;

export class CanonicalSerializationError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "CanonicalSerializationError";
	}
}

class CanonicalWriter {
	readonly #chunks: Uint8Array[] = [];
	#byteLength = 0;

	byte(value: number): void {
		const chunk = new Uint8Array([value]);
		this.#chunks.push(chunk);
		this.#byteLength++;
	}

	bytes(value: Uint8Array): void {
		if (value.byteLength === 0) return;
		this.#chunks.push(value);
		this.#byteLength += value.byteLength;
	}

	uint64(value: number): void {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new CanonicalSerializationError(`Invalid canonical byte length: ${value}`);
		}
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
		this.bytes(bytes);
	}

	lengthPrefixed(value: Uint8Array): void {
		this.uint64(value.byteLength);
		this.bytes(value);
	}

	finish(): Uint8Array {
		const output = new Uint8Array(this.#byteLength);
		let offset = 0;
		for (const chunk of this.#chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return output;
	}
}

const enum Tag {
	Absent = 0x00,
	Null = 0x01,
	False = 0x02,
	True = 0x03,
	Number = 0x04,
	BigInt = 0x05,
	String = 0x06,
	Binary = 0x07,
	Array = 0x08,
	Object = 0x09,
	ArrayHole = 0x0a,
}

function binaryBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function writeValue(writer: CanonicalWriter, value: unknown, ancestors: Set<object>): void {
	if (value === undefined) {
		writer.byte(Tag.Absent);
		return;
	}
	if (value === null) {
		writer.byte(Tag.Null);
		return;
	}

	switch (typeof value) {
		case "boolean":
			writer.byte(value ? Tag.True : Tag.False);
			return;
		case "number": {
			writer.byte(Tag.Number);
			const bytes = new Uint8Array(8);
			const view = new DataView(bytes.buffer);
			// Canonicalize every NaN to one quiet-NaN representation. All other
			// IEEE-754 bits, including -0, are retained exactly.
			if (Number.isNaN(value)) view.setBigUint64(0, 0x7ff8_0000_0000_0000n, false);
			else view.setFloat64(0, value, false);
			writer.bytes(bytes);
			return;
		}
		case "bigint":
			writer.byte(Tag.BigInt);
			writer.lengthPrefixed(encoder.encode(value.toString(10)));
			return;
		case "string":
			writer.byte(Tag.String);
			writer.lengthPrefixed(encoder.encode(value));
			return;
		case "symbol":
		case "function":
			throw new CanonicalSerializationError(`Unsupported canonical value: ${typeof value}`);
		case "object":
			break;
	}

	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		writer.byte(Tag.Binary);
		writer.lengthPrefixed(binaryBytes(value));
		return;
	}

	if (ancestors.has(value)) throw new CanonicalSerializationError("Canonical values must not contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			writer.byte(Tag.Array);
			writer.uint64(value.length);
			for (let index = 0; index < value.length; index++) {
				if (!(index in value)) writer.byte(Tag.ArrayHole);
				else writeValue(writer, value[index], ancestors);
			}
			return;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new CanonicalSerializationError(
				`Unsupported canonical object prototype: ${prototype?.constructor?.name ?? "null"}`,
			);
		}
		if (Object.getOwnPropertySymbols(value).some(symbol => Object.prototype.propertyIsEnumerable.call(value, symbol))) {
			throw new CanonicalSerializationError("Enumerable symbol keys are not canonicalizable");
		}

		writer.byte(Tag.Object);
		const keys = Object.keys(value as Record<string, unknown>).sort();
		writer.uint64(keys.length);
		for (const key of keys) {
			writer.lengthPrefixed(encoder.encode(key));
			writeValue(writer, (value as Record<string, unknown>)[key], ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

/**
 * Serialize a semantic value into a versioned, unambiguous byte representation.
 *
 * Object keys use deterministic UTF-16 code-unit ordering; arrays retain order
 * and holes; absent (`undefined`) and null have distinct tags; numbers retain
 * their IEEE-754 value; bigints use exact decimal text; binary views retain the
 * exact bytes in their selected range.
 */
export function canonicalSerialize(value: unknown): Uint8Array {
	const writer = new CanonicalWriter();
	writer.byte(CANONICAL_SERIALIZATION_VERSION);
	writeValue(writer, value, new Set());
	return writer.finish();
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
	const a = canonicalSerialize(left);
	const b = canonicalSerialize(right);
	if (a.byteLength !== b.byteLength) return false;
	return a.every((byte, index) => byte === b[index]);
}
