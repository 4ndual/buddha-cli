import { canonicalBytes, canonicalSha256, type CanonicalValue } from "../identity/canonical";

const encoder = new TextEncoder();

/** Stable textual envelope for the shared binary canonical identity representation. */
export function canonicalJson(value: unknown): string {
	return `omp-semantic-v1:${Buffer.from(canonicalBytes(value as CanonicalValue)).toString("base64url")}`;
}

export function sha256Bytes(value: Uint8Array | string): string {
	const bytes = typeof value === "string" ? encoder.encode(value) : value;
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Shared storage-domain semantic hash; absent/null, exact decimals, and binary bytes remain distinct. */
export function semanticHash(value: unknown): string {
	return canonicalSha256(value as CanonicalValue);
}
