import { describe, expect, it } from "bun:test";
import {
	MAX_CURSOR_BYTES,
	MAX_PAGE_LIMIT,
	MAX_PAYLOAD_CHUNK_BYTES,
	boundPageRequest,
	boundPayloadStreamRequest,
	decodePageCursor,
	encodePageCursor,
	originId,
	payloadId,
} from "../src/storage";

describe("SessionRepository pagination contract", () => {
	it("round-trips an opaque keyset cursor without depending on caller key order", () => {
		const left = encodePageCursor({ version: 9, sortKey: "2026-09-15", branch: "b" });
		const right = encodePageCursor({ branch: "b", sortKey: "2026-09-15", version: 9 });

		expect(left).toBe(right);
		expect(decodePageCursor(left)).toEqual({ branch: "b", sortKey: "2026-09-15", version: 9 });
	});

	it("rejects unbounded pages and oversized cursors before a backend query", () => {
		expect(() => boundPageRequest({ limit: MAX_PAGE_LIMIT + 1 })).toThrow(RangeError);
		expect(() => boundPageRequest({ limit: 0 })).toThrow(RangeError);
		expect(() => boundPageRequest({ cursor: "x".repeat(MAX_CURSOR_BYTES + 1) as never })).toThrow(RangeError);
		expect(() => encodePageCursor({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError);
		expect(() => encodePageCursor({ key: "x".repeat(MAX_CURSOR_BYTES) })).toThrow(RangeError);
	});

	it("rejects malformed or foreign-version cursors instead of treating them as offsets", () => {
		expect(() => decodePageCursor("other.abc" as never)).toThrow("Unsupported page cursor version");
		const malformed = `omp-storage-cursor-v1.${Buffer.from("[]").toString("base64url")}`;
		expect(() => decodePageCursor(malformed as never)).toThrow("Malformed page cursor");
	});
});

describe("SessionRepository stream bounds", () => {
	it("normalizes a bounded payload stream and rejects allocation-sized chunks", () => {
		const request = boundPayloadStreamRequest({ payloadId: payloadId({ bytes: new Uint8Array() }) });
		expect(request).toMatchObject({ offset: 0, chunkBytes: 64 * 1024 });
		expect(() =>
			boundPayloadStreamRequest({
				payloadId: payloadId({}),
				chunkBytes: MAX_PAYLOAD_CHUNK_BYTES + 1,
			}),
		).toThrow(RangeError);
	});

	it("does not permit unsafe byte offsets that would lose integer precision", () => {
		const id = payloadId({ origin: originId({ harness: "omp", installNamespace: "p", nativeSessionId: "s" }) });
		expect(() => boundPayloadStreamRequest({ payloadId: id, offset: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
	});
});
