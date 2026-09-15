import { isRecord } from "@oh-my-pi/pi-utils";

export type SourceFormat =
	| "omp-jsonl-v3"
	| "pi-jsonl-legacy"
	| "claude-jsonl"
	| "codex-jsonl"
	| "generic-jsonl"
	| "bundle-manifest"
	| "sqlite-database"
	| "archive"
	| "unknown-text"
	| "binary"
	| "empty";

export type AdapterDisposition = "resumable" | "resumable-with-mapping" | "archive-only" | "quarantined";

export interface ContentClassification {
	readonly format: SourceFormat;
	readonly version: string;
	readonly confidence: "exact" | "strong" | "weak";
	readonly evidence: readonly string[];
	readonly malformedRecords: number;
	readonly truncated: boolean;
}

export interface SourceAdapterDescriptor {
	readonly id: string;
	readonly format: SourceFormat;
	readonly acceptedVersions: readonly string[];
	readonly disposition: Exclude<AdapterDisposition, "quarantined">;
	readonly normalizable: boolean;
	readonly preserves: readonly string[];
	readonly limitations: readonly string[];
}

export const SOURCE_ADAPTER_MATRIX: readonly SourceAdapterDescriptor[] = [
	{
		id: "omp-v3",
		format: "omp-jsonl-v3",
		acceptedVersions: ["3"],
		disposition: "resumable",
		normalizable: true,
		preserves: ["entry graph", "messages", "tool pairs", "compactions", "custom records", "titles"],
		limitations: ["external extension state is provenance only"],
	},
	{
		id: "pi-v1-v2",
		format: "pi-jsonl-legacy",
		acceptedVersions: ["1", "2"],
		disposition: "resumable-with-mapping",
		normalizable: true,
		preserves: ["record order", "messages", "known control records", "unknown records as provenance"],
		limitations: ["missing entry identities are deterministically reconstructed", "workspace availability is not inferred"],
	},
	{
		id: "claude-jsonl",
		format: "claude-jsonl",
		acceptedVersions: ["content-signature-v1"],
		disposition: "archive-only",
		normalizable: true,
		preserves: ["messages", "tool call/result pairs", "thinking", "usage", "raw records as provenance"],
		limitations: ["Claude process and extension state cannot be resumed exactly"],
	},
	{
		id: "codex-jsonl",
		format: "codex-jsonl",
		acceptedVersions: ["rollout-v1"],
		disposition: "archive-only",
		normalizable: true,
		preserves: ["messages", "tool call/result pairs", "reasoning", "raw records as provenance"],
		limitations: ["Codex process state cannot be resumed exactly"],
	},
	{
		id: "generic-jsonl",
		format: "generic-jsonl",
		acceptedVersions: ["unknown"],
		disposition: "archive-only",
		normalizable: true,
		preserves: ["every object record as non-context migration provenance"],
		limitations: ["no conversational semantics are inferred"],
	},
	{
		id: "bundle-manifest",
		format: "bundle-manifest",
		acceptedVersions: ["unknown"],
		disposition: "archive-only",
		normalizable: false,
		preserves: ["byte-exact immutable copy"],
		limitations: ["bundle members require explicit independent inventory"],
	},
] as const;

const decoder = new TextDecoder("utf-8", { fatal: true });


function parseJsonLines(text: string): {
	records: Record<string, unknown>[];
	malformed: number;
	truncated: boolean;
} {
	const records: Record<string, unknown>[] = [];
	let malformed = 0;
	let truncated = false;
	const hasFinalNewline = text.endsWith("\n") || text.endsWith("\r");
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) records.push(parsed);
			else malformed += 1;
		} catch {
			malformed += 1;
			if (index === lines.length - 1 && !hasFinalNewline) truncated = true;
		}
	}
	return { records, malformed, truncated };
}

function looksLikeBundleManifest(record: Record<string, unknown>): boolean {
	return (
		(typeof record.manifestVersion === "string" || typeof record.schemaVersion === "string") &&
		(Array.isArray(record.sessions) || Array.isArray(record.files) || Array.isArray(record.items))
	);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((byte, index) => bytes[index] === byte);
}

/** Classify a bounded content prefix. File names are deliberately not consulted. */
export function classifySourceContent(bytes: Uint8Array, prefixIsComplete: boolean): ContentClassification {
	if (bytes.byteLength === 0) {
		return {
			format: "empty",
			version: "0",
			confidence: "exact",
			evidence: ["zero-byte content"],
			malformedRecords: 0,
			truncated: false,
		};
	}
	if (startsWith(bytes, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])) {
		return {
			format: "sqlite-database",
			version: "3",
			confidence: "exact",
			evidence: ["SQLite format 3 content header"],
			malformedRecords: 0,
			truncated: false,
		};
	}
	if (
		startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
		startsWith(bytes, [0x1f, 0x8b]) ||
		startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd])
	) {
		return {
			format: "archive",
			version: "content-signature-v1",
			confidence: "exact",
			evidence: ["recognized archive content signature"],
			malformedRecords: 0,
			truncated: false,
		};
	}
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		return {
			format: "binary",
			version: "unknown",
			confidence: "strong",
			evidence: ["prefix is not valid UTF-8"],
			malformedRecords: 0,
			truncated: false,
		};
	}
	if (text.includes("\u0000")) {
		return {
			format: "binary",
			version: "unknown",
			confidence: "strong",
			evidence: ["NUL byte in content prefix"],
			malformedRecords: 0,
			truncated: false,
		};
	}
	const parsed = parseJsonLines(text);
	const records = parsed.records;
	const first = records[0];
	const session = first?.type === "title" ? records[1] : first;
	const malformedRecords = parsed.malformed;
	const truncated = prefixIsComplete && parsed.truncated;
	if (session?.type === "session" && typeof session.id === "string") {
		const version = typeof session.version === "number" ? String(session.version) : "1";
		return {
			format: version === "3" ? "omp-jsonl-v3" : "pi-jsonl-legacy",
			version,
			confidence: "exact",
			evidence: ["leading session record", `declared schema version ${version}`],
			malformedRecords,
			truncated,
		};
	}
	if (
		records.some(
			record =>
				(record.type === "user" || record.type === "assistant") &&
				isRecord(record.message) &&
				(typeof record.sessionId === "string" || typeof record.uuid === "string"),
		)
	) {
		return {
			format: "claude-jsonl",
			version: "content-signature-v1",
			confidence: "strong",
			evidence: ["Claude user/assistant envelope with message and session identity"],
			malformedRecords,
			truncated,
		};
	}
	if (
		records.some(
			record =>
				record.type === "session_meta" ||
				record.type === "response_item" ||
				record.type === "event_msg" ||
				record.type === "turn_context",
		)
	) {
		return {
			format: "codex-jsonl",
			version: "rollout-v1",
			confidence: "strong",
			evidence: ["Codex rollout event envelope"],
			malformedRecords,
			truncated,
		};
	}
	if (records.length === 1 && looksLikeBundleManifest(records[0])) {
		return {
			format: "bundle-manifest",
			version:
				typeof records[0].manifestVersion === "string"
					? records[0].manifestVersion
					: String(records[0].schemaVersion),
			confidence: "strong",
			evidence: ["versioned manifest object with item collection"],
			malformedRecords,
			truncated,
		};
	}
	if (records.length > 0) {
		return {
			format: "generic-jsonl",
			version: "unknown",
			confidence: records.length > 1 ? "strong" : "weak",
			evidence: [`${records.length} JSON object record(s) in bounded prefix`],
			malformedRecords,
			truncated,
		};
	}
	return {
		format: "unknown-text",
		version: "unknown",
		confidence: "weak",
		evidence: [malformedRecords > 0 ? "text contains no valid JSON object records" : "UTF-8 text without recognized records"],
		malformedRecords,
		truncated,
	};
}

export function adapterForFormat(format: SourceFormat): SourceAdapterDescriptor | undefined {
	return SOURCE_ADAPTER_MATRIX.find(adapter => adapter.format === format);
}
