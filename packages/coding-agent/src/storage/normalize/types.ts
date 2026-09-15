import type {
	BranchId,
	ContextHash,
	EventHash,
	OriginId,
	ReplicaId,
	SessionDisposition,
	SourceAlias,
	VersionId,
} from "../contracts";
import type { FileEntry, SessionEntry, SessionHeader } from "../../session/session-entries";

export type HarnessFormat =
	| "omp-v1"
	| "omp-v2"
	| "omp-v3"
	| "claude-jsonl"
	| "codex-rollout-jsonl"
	| "jcode-session-json"
	| "unknown";

export type NormalizationDisposition = SessionDisposition;

export interface NormalizationLimits {
	/** Maximum bytes consumed from one source file, including newlines. */
	inputBytes: number;
	/** Maximum bytes allowed for one physical JSONL record. */
	recordBytes: number;
	/** Maximum number of physical JSONL records. */
	records: number;
}

export interface NormalizeSessionOptions {
	inputPath: string;
	/** Stable harness/install namespace, for example `claude:default`. */
	sourceNamespace: string;
	/** Native session id when known from an index; the adapter otherwise derives it from content. */
	nativeSessionId?: string;
	/** Explicit workspace fallback. Never inferred from the current process cwd. */
	fallbackCwd?: string;
	limits?: Partial<NormalizationLimits>;
}

export interface RawObjectReference {
	line: number;
	byteLength: number;
	sha256: string;
	ref: string;
	mediaType: "application/json" | "application/octet-stream";
}

export interface AttachmentReference {
	sha256: string;
	ref: string;
	byteLength: number;
	mediaType: string;
	encoding: "base64";
}

export interface PreservedObject {
	ref: string;
	mediaType: string;
	bytes: Uint8Array;
}

export interface NormalizationDiagnostic {
	code:
		| "cycle"
		| "duplicate-id"
		| "input-byte-limit"
		| "malformed-json"
		| "missing-critical-payload"
		| "missing-parent"
		| "record-byte-limit"
		| "record-count-limit"
		| "unsupported-format"
		| "unknown-control-event"
		| "unpaired-tool-call"
		| "unpaired-tool-result";
	line?: number;
	entryId?: string;
	detail: string;
}

export interface NormalizationManifest {
	adapter: string;
	adapterVersion: 1;
	format: HarnessFormat;
	disposition: NormalizationDisposition;
	reasons: string[];
	origin_id: OriginId;
	source_alias: SourceAlias;
	event_hashes: EventHash[];
	version_id: VersionId;
	branch_id: BranchId;
	fork_point_hash: EventHash | null;
	parent_version_id: VersionId | null;
	replica_id: ReplicaId;
	native_session_id: string;
	selected_leaf_id: string | null;
	source_sha256: string;
	source_bytes: number;
	source_records: number;
	normalized_sha256: string | null;
	normalized_bytes: number;
	raw_records: RawObjectReference[];
	attachments: AttachmentReference[];
	diagnostics: NormalizationDiagnostic[];
	context_hash: ContextHash | null;
}

export interface NormalizationBundle {
	manifest: NormalizationManifest;
	/** Current OMP v3 records. Empty only for quarantined inputs that cannot be represented safely. */
	records: FileEntry[];
	/** Fixed title slot plus newline-terminated OMP JSONL records. */
	jsonl: string;
	/** Raw records and decoded inline attachments addressed by immutable refs. */
	objects: PreservedObject[];
}

export interface AdapterInputRecord {
	line: number;
	raw: Uint8Array;
	value: Record<string, unknown>;
	ref: RawObjectReference;
}

export interface AdapterOutput {
	format: Exclude<HarnessFormat, "unknown">;
	header: SessionHeader;
	entries: SessionEntry[];
	selectedLeafId: string | null;
	nativeSessionId: string;
	title?: { title: string; source?: "auto" | "user"; updatedAt: string };
	disposition: Exclude<NormalizationDisposition, "quarantined">;
	reasons: string[];
	diagnostics: NormalizationDiagnostic[];
	attachments: AttachmentReference[];
	objects: PreservedObject[];
}
