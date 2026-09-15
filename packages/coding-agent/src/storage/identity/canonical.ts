export const CANONICALIZER_VERSION = 1;
export const DEFAULT_MAX_CANONICAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_CANONICAL_DEPTH = 256;

export class ExactDecimal {
	#value: string;

	constructor(value: string) {
		if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
			throw new TypeError(`Invalid exact decimal: ${value}`);
		}
		this.#value = value;
	}

	toString(): string {
		return this.#value;
	}
}

export function exactDecimal(value: string): ExactDecimal {
	return new ExactDecimal(value);
}

export type CanonicalScalar = null | undefined | boolean | string | number | bigint | ExactDecimal;
export type CanonicalValue =
	| CanonicalScalar
	| ArrayBuffer
	| ArrayBufferView
	| readonly CanonicalValue[]
	| { readonly [key: string]: CanonicalValue };

export interface CanonicalizeOptions {
	maxBytes?: number;
	maxDepth?: number;
}

const encoder = new TextEncoder();
const MAGIC = encoder.encode(`OMPSEM\0${CANONICALIZER_VERSION}\0`);

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = left[index] - right[index];
		if (difference !== 0) return difference;
	}
	return left.length - right.length;
}

function unsignedVarint(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Canonical length must be a non-negative safe integer");
	const bytes: number[] = [];
	let remaining = value;
	do {
		const next = remaining % 128;
		remaining = Math.floor(remaining / 128);
		bytes.push(next | (remaining > 0 ? 0x80 : 0));
	} while (remaining > 0);
	return Uint8Array.from(bytes);
}

function byte(value: number): Uint8Array {
	return Uint8Array.of(value);
}

class CanonicalWriter {
	#segments: Uint8Array[] = [MAGIC];
	#length = MAGIC.byteLength;
	#seen = new Set<object>();
	#maxBytes: number;
	#maxDepth: number;

	constructor(options: CanonicalizeOptions) {
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_CANONICAL_BYTES;
		this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_CANONICAL_DEPTH;
		if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < MAGIC.byteLength) {
			throw new RangeError("maxBytes must be a positive safe integer");
		}
		if (!Number.isSafeInteger(this.#maxDepth) || this.#maxDepth < 1) {
			throw new RangeError("maxDepth must be a positive safe integer");
		}
	}

	#push(segment: Uint8Array): void {
		this.#length += segment.byteLength;
		if (this.#length > this.#maxBytes) throw new RangeError(`Canonical value exceeds ${this.#maxBytes} bytes`);
		this.#segments.push(segment);
	}

	#pushSized(tag: number, bytes: Uint8Array): void {
		this.#push(byte(tag));
		this.#push(unsignedVarint(bytes.byteLength));
		this.#push(bytes);
	}

	#withContainer(value: object, visit: () => void): void {
		if (this.#seen.has(value)) throw new TypeError("Canonical values must not contain cycles or repeated references");
		this.#seen.add(value);
		try {
			visit();
		} finally {
			this.#seen.delete(value);
		}
	}

	write(value: CanonicalValue, depth = 0): void {
		if (depth > this.#maxDepth) throw new RangeError(`Canonical value exceeds depth ${this.#maxDepth}`);
		if (value === undefined) {
			this.#push(byte(0x00));
			return;
		}
		if (value === null) {
			this.#push(byte(0x01));
			return;
		}
		if (value === false) {
			this.#push(byte(0x02));
			return;
		}
		if (value === true) {
			this.#push(byte(0x03));
			return;
		}
		if (typeof value === "string") {
			this.#pushSized(0x04, encoder.encode(value));
			return;
		}
		if (typeof value === "number") {
			const bytes = new Uint8Array(8);
			const view = new DataView(bytes.buffer);
			if (Number.isNaN(value)) {
				view.setUint32(0, 0x7ff8_0000, false);
				view.setUint32(4, 0, false);
			} else {
				view.setFloat64(0, value, false);
			}
			this.#push(byte(0x05));
			this.#push(bytes);
			return;
		}
		if (typeof value === "bigint") {
			this.#pushSized(0x06, encoder.encode(value.toString(10)));
			return;
		}
		if (value instanceof ExactDecimal) {
			this.#pushSized(0x07, encoder.encode(value.toString()));
			return;
		}
		if (value instanceof ArrayBuffer) {
			this.#pushSized(0x08, new Uint8Array(value));
			return;
		}
		if (ArrayBuffer.isView(value)) {
			this.#pushSized(0x08, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
			return;
		}
		if (Array.isArray(value)) {
			this.#withContainer(value, () => {
				this.#push(byte(0x09));
				this.#push(unsignedVarint(value.length));
				for (let index = 0; index < value.length; index++) {
					if (index in value) this.write(value[index], depth + 1);
					else this.#push(byte(0x0b));
				}
			});
			return;
		}
		if (typeof value === "object") {
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError(`Unsupported canonical object: ${prototype?.constructor?.name ?? "null"}`);
			}
			this.#withContainer(value, () => {
				const entries = Object.keys(value)
					.map(key => ({ key, bytes: encoder.encode(key) }))
					.sort((left, right) => compareBytes(left.bytes, right.bytes));
				this.#push(byte(0x0a));
				this.#push(unsignedVarint(entries.length));
				for (const entry of entries) {
					this.#push(unsignedVarint(entry.bytes.byteLength));
					this.#push(entry.bytes);
					this.write((value as Record<string, CanonicalValue>)[entry.key], depth + 1);
				}
			});
			return;
		}
		throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
	}

	finish(): Uint8Array {
		const result = new Uint8Array(this.#length);
		let offset = 0;
		for (const segment of this.#segments) {
			result.set(segment, offset);
			offset += segment.byteLength;
		}
		return result;
	}
}

/**
 * Versioned deterministic semantic encoding. Object keys use UTF-8 byte order;
 * array order, sparse slots, undefined, null, IEEE-754 bits, bigints, exact
 * decimal text, and binary bytes all remain distinct.
 */
export function canonicalBytes(value: CanonicalValue, options: CanonicalizeOptions = {}): Uint8Array {
	const writer = new CanonicalWriter(options);
	writer.write(value);
	return writer.finish();
}

export function canonicalSha256(value: CanonicalValue, options: CanonicalizeOptions = {}): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(canonicalBytes(value, options));
	return `sha256:${hasher.digest("hex")}`;
}

export const DEFAULT_NON_SEMANTIC_KEYS: Readonly<Record<string, true>> = {
	exportPath: true,
	exportedAt: true,
	padding: true,
	pad: true,
	transferTimestamp: true,
	transportBookkeeping: true,
};

export interface SemanticProjectionOptions {
	excludedKeys?: Readonly<Record<string, true>>;
}

/** Removes transport-only object fields without changing array positions or semantic scalar values. */
export function semanticProjection(value: CanonicalValue, options: SemanticProjectionOptions = {}): CanonicalValue {
	const excluded = options.excludedKeys ?? DEFAULT_NON_SEMANTIC_KEYS;
	if (Array.isArray(value)) return value.map(item => semanticProjection(item, options));
	if (
		value === null ||
		value === undefined ||
		typeof value !== "object" ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value) ||
		value instanceof ExactDecimal
	) {
		return value;
	}
	const projected: Record<string, CanonicalValue> = {};
	for (const [key, child] of Object.entries(value)) {
		if (!(key in excluded)) projected[key] = semanticProjection(child, options);
	}
	return projected;
}

export interface CanonicalIdentityRecord {
	hash: string;
	canonicalLength: number;
	canonical: Uint8Array;
}

export function canonicalIdentityRecord(value: CanonicalValue): CanonicalIdentityRecord {
	const canonical = canonicalBytes(value);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(canonical);
	return { hash: `sha256:${hasher.digest("hex")}`, canonicalLength: canonical.byteLength, canonical };
}

/** Hash equality is accepted only after byte length and canonical bytes also match. */
export function assertSameCanonicalIdentity(left: CanonicalIdentityRecord, right: CanonicalIdentityRecord): void {
	if (left.hash !== right.hash) return;
	if (left.canonicalLength !== right.canonicalLength || !left.canonical.every((value, index) => right.canonical[index] === value)) {
		throw new Error(`Canonical hash collision detected for ${left.hash}`);
	}
}
