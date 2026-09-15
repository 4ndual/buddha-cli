import { isRecord } from "@oh-my-pi/pi-utils";
import { sha256Bytes } from "./canonical";
import type {
	AdapterInputRecord,
	NormalizationDiagnostic,
	NormalizationLimits,
	PreservedObject,
	RawObjectReference,
} from "./types";

const decoder = new TextDecoder("utf-8", { fatal: true });

export const DEFAULT_NORMALIZATION_LIMITS: NormalizationLimits = {
	inputBytes: 64 * 1024 * 1024,
	recordBytes: 8 * 1024 * 1024,
	records: 1_000_000,
};

export interface StreamJsonlResult {
	records: AdapterInputRecord[];
	rawRecords: RawObjectReference[];
	objects: PreservedObject[];
	diagnostics: NormalizationDiagnostic[];
	sourceSha256: string;
	sourceBytes: number;
	complete: boolean;
}

function lineReference(line: number, raw: Uint8Array): RawObjectReference {
	const sha256 = sha256Bytes(raw);
	return {
		line,
		byteLength: raw.byteLength,
		sha256,
		ref: `raw/sha256/${sha256}`,
		mediaType: "application/json",
	};
}

/** Reads JSONL incrementally and stops before a configured byte, record, or line-size budget can grow unbounded. */
export async function streamJsonl(
	filePath: string,
	limits: NormalizationLimits,
): Promise<StreamJsonlResult> {
	const records: AdapterInputRecord[] = [];
	const rawRecords: RawObjectReference[] = [];
	const objects: PreservedObject[] = [];
	const diagnostics: NormalizationDiagnostic[] = [];
	const sourceHasher = new Bun.CryptoHasher("sha256");
	const file = Bun.file(filePath);
	const sourceBytes = file.size;
	let buffered = new Uint8Array();
	let line = 0;
	let complete = true;
	if (sourceBytes > limits.inputBytes) {
		for await (const chunk of file.stream()) sourceHasher.update(chunk);
		diagnostics.push({
			code: "input-byte-limit",
			detail: `Input is ${sourceBytes} bytes; parse limit is ${limits.inputBytes} bytes (full file streamed only for SHA-256 accounting)`,
		});
		return {
			records,
			rawRecords,
			objects,
			diagnostics,
			sourceSha256: sourceHasher.digest("hex"),
			sourceBytes,
			complete: false,
		};
	}

	const consumeLine = (physical: Uint8Array): boolean => {
		line += 1;
		let raw = physical;
		if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
		if (raw.byteLength === 0) return true;
		if (raw.byteLength > limits.recordBytes) {
			diagnostics.push({
				code: "record-byte-limit",
				line,
				detail: `Record is ${raw.byteLength} bytes; limit is ${limits.recordBytes}`,
			});
			return false;
		}
		if (records.length >= limits.records) {
			diagnostics.push({
				code: "record-count-limit",
				line,
				detail: `Input exceeds ${limits.records} records`,
			});
			return false;
		}
		const ref = lineReference(line, raw);
		rawRecords.push(ref);
		objects.push({ ref: ref.ref, mediaType: ref.mediaType, bytes: raw.slice() });
		try {
			const value: unknown = JSON.parse(decoder.decode(raw));
			if (!isRecord(value)) {
				diagnostics.push({ code: "malformed-json", line, detail: "JSONL record must be an object" });
				return false;
			}
			records.push({ line, raw: raw.slice(), value, ref });
			return true;
		} catch (error) {
			diagnostics.push({
				code: "malformed-json",
				line,
				detail: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	};

	for await (const chunk of file.stream()) {
		sourceHasher.update(chunk);
		if (!complete) continue;
		buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
		let newline = buffered.indexOf(0x0a);
		while (newline !== -1) {
			if (!consumeLine(buffered.subarray(0, newline))) {
				complete = false;
				buffered = new Uint8Array();
				break;
			}
			buffered = buffered.subarray(newline + 1);
			newline = buffered.indexOf(0x0a);
		}
		if (!complete) continue;
		if (buffered.byteLength > limits.recordBytes) {
			diagnostics.push({
				code: "record-byte-limit",
				line: line + 1,
				detail: `Record exceeded ${limits.recordBytes} bytes before its newline`,
			});
			complete = false;
			buffered = new Uint8Array();
		}
	}
	if (complete && buffered.byteLength > 0 && !consumeLine(buffered)) complete = false;

	return {
		records,
		rawRecords,
		objects,
		diagnostics,
		sourceSha256: sourceHasher.digest("hex"),
		sourceBytes,
		complete,
	};
}
