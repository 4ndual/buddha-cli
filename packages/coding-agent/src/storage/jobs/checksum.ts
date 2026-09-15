export type JobJson = null | boolean | number | string | JobJson[] | { [key: string]: JobJson };

function serialize(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Job JSON cannot contain a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
	if (typeof value !== "object" || value === undefined) {
		throw new Error(`Job JSON cannot contain ${typeof value}`);
	}
	const prototype = Object.getPrototypeOf(value) as object | null;
	if (prototype !== Object.prototype && prototype !== null) throw new Error("Job JSON requires plain objects");
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry)}`).join(",")}}`;
}

/** Canonical transport JSON for job bookkeeping. Event semantic hashes use storage/identity instead. */
export function canonicalJobJson(value: unknown): string {
	return serialize(value);
}

export function sha256Bytes(value: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function checksumJobJson(value: unknown): string {
	return sha256Bytes(canonicalJobJson(value));
}
