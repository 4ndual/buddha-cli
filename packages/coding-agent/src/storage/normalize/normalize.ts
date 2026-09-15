import type { SessionEntry, SessionHeader, TitleChangeEntry } from "../../session/session-entries";
import { CURRENT_SESSION_VERSION } from "../../session/session-entries";
import { buildSessionContext } from "../../session/session-context";
import { parseSessionContent } from "../../session/session-loader";
import { migrateToCurrentVersion } from "../../session/session-migrations";
import { serializeTitleSlot } from "../../session/session-title-slot";
import type { ContextHash, EventHash, OriginId } from "../contracts";
import type { CanonicalValue } from "../identity/canonical";
import {
	branchId as makeBranchId,
	contextHash as makeContextHash,
	eventIdentityRecord,
	metadataRevisionId,
	originId as makeOriginId,
	replicaId as makeReplicaId,
	sourceAlias as makeSourceAlias,
	versionId as makeVersionId,
} from "../identity/identifiers";
import { adaptRecords, detectHarness } from "./adapters";
import { canonicalJson, semanticHash, sha256Bytes } from "./canonical";
import { DEFAULT_NORMALIZATION_LIMITS, streamJsonl, type StreamJsonlResult } from "./stream-jsonl";
import type {
	AdapterInputRecord,
	AdapterOutput,
	NormalizationBundle,
	NormalizationDiagnostic,
	NormalizationDisposition,
	NormalizationLimits,
	NormalizationManifest,
	NormalizeSessionOptions,
	PreservedObject,
	RawObjectReference,
} from "./types";

export interface NormalizeRecordsOptions {
	records: readonly AdapterInputRecord[];
	rawRecords?: readonly RawObjectReference[];
	objects?: readonly PreservedObject[];
	sourceNamespace: string;
	nativeSessionId?: string;
	fallbackCwd?: string;
	sourceSha256: string;
	sourceBytes: number;
	diagnostics?: readonly NormalizationDiagnostic[];
	complete?: boolean;
}

function deterministicEntryId(kind: string, value: unknown): string {
	return `migration-${kind}-${semanticHash(value).slice(-16)}`;
}

function identitySeed(sourceNamespace: string, nativeSessionId: string) {
	const separator = sourceNamespace.indexOf(":");
	return {
		harness: separator > 0 ? sourceNamespace.slice(0, separator) : sourceNamespace,
		installNamespace: sourceNamespace,
		nativeSessionId,
	};
}

function computeEventHashes(originId: OriginId, entries: readonly SessionEntry[]): EventHash[] {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const memo = new Map<string, EventHash>();
	const active = new Set<string>();
	const visit = (entry: SessionEntry): EventHash => {
		const existing = memo.get(entry.id);
		if (existing) return existing;
		if (active.has(entry.id)) throw new Error(`Cannot hash cyclic entry graph at ${entry.id}`);
		active.add(entry.id);
		const parentHash = entry.parentId ? (byId.has(entry.parentId) ? visit(byId.get(entry.parentId)!) : null) : null;
		const payload: Record<string, unknown> = { ...entry };
		delete payload.id;
		delete payload.parentId;
		const { eventHash } = eventIdentityRecord({
			originId,
			nativeEntryId: entry.id,
			parentHash,
			kind: entry.type,
			timestamp: entry.timestamp,
			semanticPayload: payload as CanonicalValue,
		});
		active.delete(entry.id);
		memo.set(entry.id, eventHash);
		return eventHash;
	};
	return entries.map(visit);
}

function dispositionForDiagnostics(
	requested: Exclude<NormalizationDisposition, "quarantined">,
	diagnostics: readonly NormalizationDiagnostic[],
): NormalizationDisposition {
	const fatal = diagnostics.some(diagnostic =>
		[
			"cycle",
			"duplicate-id",
			"input-byte-limit",
			"malformed-json",
			"missing-critical-payload",
			"missing-parent",
			"record-byte-limit",
			"record-count-limit",
			"unpaired-tool-call",
			"unpaired-tool-result",
		].includes(diagnostic.code),
	);
	return fatal ? "quarantined" : requested;
}

function serializeBundleRecords(header: SessionHeader, entries: readonly SessionEntry[], output: AdapterOutput): string {
	const slot = serializeTitleSlot(
		output.title ?? {
			title: header.title,
			source: header.titleSource,
			updatedAt: header.timestamp,
		},
	);
	return `${slot}${JSON.stringify(header)}\n${entries.map(entry => JSON.stringify(entry)).join("\n")}${entries.length > 0 ? "\n" : ""}`;
}

function deduplicateObjects(objects: readonly PreservedObject[]): PreservedObject[] {
	const byRef = new Map<string, PreservedObject>();
	for (const object of objects) if (!byRef.has(object.ref)) byRef.set(object.ref, object);
	return [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

function quarantineBundle(args: {
	sourceNamespace: string;
	nativeSessionId: string;
	sourceSha256: string;
	sourceBytes: number;
	rawRecords: RawObjectReference[];
	objects: PreservedObject[];
	diagnostics: NormalizationDiagnostic[];
	format?: NormalizationManifest["format"];
}): NormalizationBundle {
	const seed = identitySeed(args.sourceNamespace, args.nativeSessionId);
	const originId = makeOriginId(seed);
	const sourceAlias = makeSourceAlias(seed);
	const replicaId = makeReplicaId("omp-wcdb-normalizer", "adapter-v1");
	const metadataId = metadataRevisionId({
		disposition: "quarantined",
		sourceSha256: args.sourceSha256,
	});
	const versionId = makeVersionId({ originId, headHash: null, metadataRevisionId: metadataId });
	const branchId = makeBranchId({ originId, replicaId, branchKey: sourceAlias });
	return {
		manifest: {
			adapter: "omp-wcdb-normalizer",
			adapterVersion: 1,
			format: args.format ?? "unknown",
			disposition: "quarantined",
			reasons: args.diagnostics.map(diagnostic => diagnostic.detail),
			origin_id: originId,
			source_alias: sourceAlias,
			event_hashes: [],
			version_id: versionId,
			branch_id: branchId,
			fork_point_hash: null,
			parent_version_id: null,
			replica_id: replicaId,
			native_session_id: args.nativeSessionId,
			selected_leaf_id: null,
			source_sha256: args.sourceSha256,
			source_bytes: args.sourceBytes,
			source_records: args.rawRecords.length,
			normalized_sha256: null,
			normalized_bytes: 0,
			raw_records: args.rawRecords,
			attachments: [],
			diagnostics: args.diagnostics,
			context_hash: null,
		},
		records: [],
		jsonl: "",
		objects: deduplicateObjects(args.objects),
	};
}

/** Normalize already-bounded parsed records. File callers should use normalizeSessionFile so limits are enforced. */
export function normalizeRecords(options: NormalizeRecordsOptions): NormalizationBundle {
	const rawRecords = [...(options.rawRecords ?? options.records.map(record => record.ref))];
	const rawObjects = [...(options.objects ?? options.records.map(record => ({ ref: record.ref.ref, mediaType: record.ref.mediaType, bytes: record.raw })))];
	const initialDiagnostics = [...(options.diagnostics ?? [])];
	const tentativeNativeId = options.nativeSessionId ?? "unknown";
	if (options.complete === false || initialDiagnostics.some(diagnostic => diagnostic.code !== "unknown-control-event")) {
		return quarantineBundle({
			sourceNamespace: options.sourceNamespace,
			nativeSessionId: tentativeNativeId,
			sourceSha256: options.sourceSha256,
			sourceBytes: options.sourceBytes,
			rawRecords,
			objects: rawObjects,
			diagnostics: initialDiagnostics,
		});
	}
	const format = detectHarness(options.records);
	if (format === "unknown") {
		return quarantineBundle({
			sourceNamespace: options.sourceNamespace,
			nativeSessionId: tentativeNativeId,
			sourceSha256: options.sourceSha256,
			sourceBytes: options.sourceBytes,
			rawRecords,
			objects: rawObjects,
			diagnostics: [
				...initialDiagnostics,
				{ code: "unsupported-format", detail: "No deterministic adapter recognized this JSONL input" },
			],
			format,
		});
	}

	let adapted: AdapterOutput;
	try {
		adapted = adaptRecords(format, options.records, options.fallbackCwd);
	} catch (error) {
		return quarantineBundle({
			sourceNamespace: options.sourceNamespace,
			nativeSessionId: tentativeNativeId,
			sourceSha256: options.sourceSha256,
			sourceBytes: options.sourceBytes,
			rawRecords,
			objects: rawObjects,
			diagnostics: [
				...initialDiagnostics,
				{
					code: "missing-critical-payload",
					detail: error instanceof Error ? error.message : String(error),
				},
			],
			format,
		});
	}

	const nativeSessionId = options.nativeSessionId ?? adapted.nativeSessionId;
	const seed = identitySeed(options.sourceNamespace, nativeSessionId);
	const sourceAlias = makeSourceAlias(seed);
	const originId = makeOriginId(seed);
	const diagnostics = [...initialDiagnostics, ...adapted.diagnostics];
	let disposition = dispositionForDiagnostics(adapted.disposition, diagnostics);
	if (disposition === "quarantined") {
		return quarantineBundle({
			sourceNamespace: options.sourceNamespace,
			nativeSessionId,
			sourceSha256: options.sourceSha256,
			sourceBytes: options.sourceBytes,
			rawRecords,
			objects: [...rawObjects, ...adapted.objects],
			diagnostics,
			format,
		});
	}
	let selectedLeafId = adapted.selectedLeafId;
	const semanticEntries = [...adapted.entries];
	if (!format.startsWith("omp-")) {
		for (const record of options.records) {
			const sourceRecord: SessionEntry = {
				type: "custom",
				customType: `migration.source-record.${format}.v1`,
				id: deterministicEntryId("source-record", {
					format,
					line: record.line,
					rawRecordRef: record.ref.ref,
				}),
				parentId: selectedLeafId,
				timestamp: adapted.header.timestamp,
				data: {
					line: record.line,
					rawRecordRef: record.ref.ref,
					preservation: "byte-exact",
				},
			};
			semanticEntries.push(sourceRecord);
			selectedLeafId = sourceRecord.id;
		}
	}
	if (!format.startsWith("omp-") && adapted.title) {
		const titleEntry: TitleChangeEntry = {
			type: "title_change",
			id: deterministicEntryId("title", { originId, title: adapted.title }),
			parentId: selectedLeafId,
			timestamp: adapted.title.updatedAt,
			title: adapted.title.title,
			source: adapted.title.source ?? "auto",
			trigger: `${format}-normalization`,
		};
		semanticEntries.push(titleEntry);
		selectedLeafId = titleEntry.id;
	}
	const eventHashes = computeEventHashes(originId, semanticEntries);
	const headIndex = selectedLeafId ? semanticEntries.findIndex(entry => entry.id === selectedLeafId) : -1;
	const headHash = headIndex >= 0 ? eventHashes[headIndex] : null;
	const metadataId = metadataRevisionId({
		title: adapted.title?.title ?? adapted.header.title,
		titleSource: adapted.title?.source ?? adapted.header.titleSource,
		cwd: adapted.header.cwd,
		additionalDirectories: adapted.header.additionalDirectories,
	} as CanonicalValue);
	const versionId = makeVersionId({ originId, headHash, metadataRevisionId: metadataId });
	const replicaId = makeReplicaId("omp-wcdb-normalizer", "adapter-v1");
	const branchId = makeBranchId({ originId, replicaId, branchKey: sourceAlias });
	const provenanceId = deterministicEntryId("provenance", { originId, versionId, branchId, sourceAlias });
	const provenance: SessionEntry = {
		type: "custom",
		customType: "migration.provenance.v1",
		id: provenanceId,
		parentId: selectedLeafId,
		timestamp: adapted.header.timestamp,
		data: {
			origin_id: originId,
			source_alias: sourceAlias,
			version_id: versionId,
			branch_id: branchId,
			replica_id: replicaId,
			adapter: "omp-wcdb-normalizer@1",
			rawRecordRefs: rawRecords.map(reference => reference.ref),
		},
	};
	const entries = [...semanticEntries, provenance];
	selectedLeafId = provenance.id;
	const header: SessionHeader = { ...adapted.header, version: CURRENT_SESSION_VERSION };
	const records = [header, ...entries];
	const jsonl = serializeBundleRecords(header, entries, adapted);
	// The adapter graph passed fatal validation before semantic hashing.
	let contextHash: ContextHash | null = null;

	try {
		const parsed = parseSessionContent(jsonl);
		if (parsed.invalidHeader || parsed.malformedRecords > 0) throw new Error("OMP parser rejected normalized JSONL");
		if (migrateToCurrentVersion(parsed.entries)) throw new Error("Normalized output unexpectedly required a migration");
		const parsedEntries = parsed.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const context = buildSessionContext(parsedEntries, selectedLeafId);
		contextHash = makeContextHash(context as unknown as CanonicalValue);
	} catch (error) {
		diagnostics.push({
			code: "missing-critical-payload",
			detail: `OMP parser/context validation failed: ${error instanceof Error ? error.message : String(error)}`,
		});
		disposition = "quarantined";
	}

	if (disposition === "quarantined") {
		return quarantineBundle({
			sourceNamespace: options.sourceNamespace,
			nativeSessionId,
			sourceSha256: options.sourceSha256,
			sourceBytes: options.sourceBytes,
			rawRecords,
			objects: [...rawObjects, ...adapted.objects],
			diagnostics,
			format,
		});
	}
	const normalizedBytes = new TextEncoder().encode(jsonl).byteLength;
	const manifest: NormalizationManifest = {
		adapter: "omp-wcdb-normalizer",
		adapterVersion: 1,
		format,
		disposition,
		reasons: adapted.reasons,
		origin_id: originId,
		source_alias: sourceAlias,
		event_hashes: eventHashes,
		version_id: versionId,
		branch_id: branchId,
		fork_point_hash: null,
		parent_version_id: null,
		replica_id: replicaId,
		native_session_id: nativeSessionId,
		selected_leaf_id: selectedLeafId,
		source_sha256: options.sourceSha256,
		source_bytes: options.sourceBytes,
		source_records: rawRecords.length,
		normalized_sha256: sha256Bytes(jsonl),
		normalized_bytes: normalizedBytes,
		raw_records: rawRecords,
		attachments: adapted.attachments,
		diagnostics,
		context_hash: contextHash,
	};
	return { manifest, records, jsonl, objects: deduplicateObjects([...rawObjects, ...adapted.objects]) };
}

/** Stream and normalize one immutable source file without modifying it or invoking provider/tool runtimes. */
export async function normalizeSessionFile(options: NormalizeSessionOptions): Promise<NormalizationBundle> {
	const limits: NormalizationLimits = { ...DEFAULT_NORMALIZATION_LIMITS, ...options.limits };
	let streamed: StreamJsonlResult;
	try {
		streamed = await streamJsonl(options.inputPath, limits);
	} catch (error) {
		return quarantineBundle({
			sourceNamespace: options.sourceNamespace,
			nativeSessionId: options.nativeSessionId ?? "unknown",
			sourceSha256: sha256Bytes(canonicalJson({ unreadable: options.inputPath })),
			sourceBytes: 0,
			rawRecords: [],
			objects: [],
			diagnostics: [{ code: "missing-critical-payload", detail: error instanceof Error ? error.message : String(error) }],
		});
	}
	return normalizeRecords({
		records: streamed.records,
		rawRecords: streamed.rawRecords,
		objects: streamed.objects,
		sourceNamespace: options.sourceNamespace,
		nativeSessionId: options.nativeSessionId,
		fallbackCwd: options.fallbackCwd,
		sourceSha256: streamed.sourceSha256,
		sourceBytes: streamed.sourceBytes,
		diagnostics: streamed.diagnostics,
		complete: streamed.complete,
	});
}
