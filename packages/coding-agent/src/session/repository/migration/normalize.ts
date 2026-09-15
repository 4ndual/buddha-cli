import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { CURRENT_SESSION_VERSION } from "../../session-entries";
import { visitEntriesFromFileStream } from "../../session-loader";
import { adapterForFormat, type AdapterDisposition, type SourceFormat } from "./adapters";
import type { InventoryItem, InventoryManifest } from "./inventory";

const NORMALIZATION_SCHEMA_VERSION = "omp-v3-normalization-v1";
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 10_000_000;
const DEFAULT_MAX_DEPTH = 128;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024 * 1024;
const DEFAULT_MAX_NODES_PER_RECORD = 1_000_000;
const READ_BUFFER_BYTES = 128 * 1024;
const KNOWN_OMP_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"message",
	"model_usage",
	"thinking_level_change",
	"model_change",
	"service_tier_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"title_change",
	"ttsr_injection",
	"session_init",
	"mode_change",
	"credential_pin",
	"reset_boundary",
]);

export type NormalizationStatus = "normalized" | "skipped" | "quarantined";

export interface NormalizationQuarantine {
	readonly code: string;
	readonly reason: string;
	readonly line?: number;
	readonly evidence: readonly string[];
}

export interface NormalizedOutput {
	readonly jsonlPath: string;
	readonly manifestPath: string;
	readonly sha256: string;
	readonly size: string;
	readonly records: number;
	readonly disposition: Exclude<AdapterDisposition, "quarantined">;
	readonly originId: string;
	readonly sourceAlias: string;
}

export interface NormalizationResult {
	readonly schemaVersion: typeof NORMALIZATION_SCHEMA_VERSION;
	readonly itemId: string;
	readonly sourceNamespace: string;
	readonly sourceFormat: SourceFormat;
	readonly sourceSha256?: string;
	readonly status: NormalizationStatus;
	readonly output?: NormalizedOutput;
	readonly quarantine?: NormalizationQuarantine;
	readonly disposition: { readonly code: string; readonly reason: string; readonly evidence: readonly string[] };
}

export interface NormalizationManifest {
	readonly schemaVersion: typeof NORMALIZATION_SCHEMA_VERSION;
	readonly inventoryAggregateSha256: string;
	readonly sourceSnapshotAt: string;
	readonly results: readonly NormalizationResult[];
	readonly summary: {
		readonly supplied: number;
		readonly normalized: number;
		readonly skipped: number;
		readonly quarantined: number;
		readonly aggregateSha256: string;
	};
}

export interface NormalizeInventoryOptions {
	readonly backupRoot: string;
	readonly destinationRoot: string;
	readonly maxRecordBytes?: number;
	readonly maxTotalBytes?: number;
	readonly maxRecords?: number;
	readonly maxDepth?: number;
	readonly maxOutputBytes?: number;
	readonly maxNodesPerRecord?: number;
	readonly signal?: AbortSignal;
}

interface RawLine {
	readonly line: number;
	readonly raw: string;
	readonly bytes: number;
}

interface Probe {
	readonly header?: Record<string, unknown>;
	readonly title?: string;
	readonly nativeId?: string;
	readonly cwd?: string;
	readonly timestamp?: string;
}

interface ConversionState {
	readonly item: InventoryItem;
	readonly sourceFormat: SourceFormat;
	readonly originId: string;
	readonly sourceAlias: string;
	readonly timestamp: string;
	readonly usedIds: Set<string>;
	readonly parents: Map<string, string | null>;
	readonly toolCalls: Set<string>;
	readonly toolResults: Set<string>;
	readonly toolNames: Map<string, string>;
	previousId: string | null;
	recordsWritten: number;
}

class NormalizationError extends Error {
	readonly code: string;
	readonly line?: number;
	readonly evidence: readonly string[];

	constructor(code: string, message: string, line?: number, evidence: readonly string[] = []) {
		super(message);
		this.name = "NormalizationError";
		this.code = code;
		this.line = line;
		this.evidence = evidence;
	}
}

function structuredNodeCount(value: unknown, limit: number): number {
	let count = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		count += 1;
		if (count > limit) return count;
		if (Array.isArray(current)) {
			for (const child of current) pending.push(child);
		} else if (isRecord(current)) {
			for (const child of Object.values(current)) pending.push(child);
		}
	}
	return count;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Normalization cancelled", "AbortError");
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isRecord(value)) return value;
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))) {
		if (value[key] !== undefined) normalized[key] = canonicalValue(value[key]);
	}
	return normalized;
}

/** Stable serialization retains array order, sorts object keys, and keeps absent distinct from explicit null. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function validIsoTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
	return new Date(value).toISOString();
}

function timestampFromNumber(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
	return new Date(milliseconds).toISOString();
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonDepth(raw: string): number {
	let depth = 0;
	let maximum = 0;
	let quoted = false;
	let escaped = false;
	for (const character of raw) {
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === "{" || character === "[") {
			depth += 1;
			maximum = Math.max(maximum, depth);
		} else if (character === "}" || character === "]") {
			depth -= 1;
			if (depth < 0) return Number.POSITIVE_INFINITY;
		}
	}
	return quoted || depth !== 0 ? Number.POSITIVE_INFINITY : maximum;
}

function containsUnsafeInteger(raw: string): boolean {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index += 1) {
		const character = raw[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			continue;
		}
		if (character !== "-" && (character < "0" || character > "9")) continue;
		const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(index));
		if (!match) continue;
		index += match[0].length - 1;
		if (/[.eE]/.test(match[0])) continue;
		try {
			const integer = BigInt(match[0]);
			if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) return true;
		} catch {
			return true;
		}
	}
	return false;
}

async function* readBoundedLines(
	filePath: string,
	options: Required<Pick<NormalizeInventoryOptions, "maxRecordBytes" | "maxTotalBytes" | "maxRecords">> & {
		readonly signal?: AbortSignal;
	},
): AsyncGenerator<RawLine> {
	const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	const readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	let chunks: Uint8Array[] = [];
	let lineBytes = 0;
	let totalBytes = 0;
	let line = 0;
	let records = 0;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const emit = (): RawLine | undefined => {
		line += 1;
		const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, lineBytes);
		chunks = [];
		const size = lineBytes;
		lineBytes = 0;
		let raw: string;
		try {
			raw = decoder.decode(bytes).replace(/\r$/, "");
		} catch {
			throw new NormalizationError("invalid-utf8", "Record is not valid UTF-8", line);
		}
		if (!raw.trim()) return undefined;
		records += 1;
		if (records > options.maxRecords) {
			throw new NormalizationError("record-count-limit", `Input exceeds ${options.maxRecords} records`, line);
		}
		return { line, raw, bytes: size };
	};
	try {
		let position = 0;
		while (true) {
			assertNotAborted(options.signal);
			const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.byteLength, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			totalBytes += bytesRead;
			if (totalBytes > options.maxTotalBytes) {
				throw new NormalizationError("total-byte-limit", `Input exceeds ${options.maxTotalBytes} bytes`);
			}
			let start = 0;
			for (let index = 0; index < bytesRead; index += 1) {
				if (readBuffer[index] !== 0x0a) continue;
				const part = readBuffer.subarray(start, index);
				if (part.byteLength > 0) chunks.push(Uint8Array.from(part));
				lineBytes += part.byteLength;
				if (lineBytes > options.maxRecordBytes) {
					throw new NormalizationError("record-byte-limit", `Record exceeds ${options.maxRecordBytes} bytes`, line + 1);
				}
				const emitted = emit();
				if (emitted) yield emitted;
				start = index + 1;
			}
			const remaining = readBuffer.subarray(start, bytesRead);
			if (remaining.byteLength > 0) {
				chunks.push(Uint8Array.from(remaining));
				lineBytes += remaining.byteLength;
				if (lineBytes > options.maxRecordBytes) {
					throw new NormalizationError("record-byte-limit", `Record exceeds ${options.maxRecordBytes} bytes`, line + 1);
				}
			}
		}
		if (lineBytes > 0) {
			const emitted = emit();
			if (emitted) yield emitted;
		}
	} finally {
		await handle.close();
	}
}

function parseRecord(
	rawLine: RawLine,
	maxDepth: number,
	maxNodesPerRecord: number,
): Record<string, unknown> {
	const depth = jsonDepth(rawLine.raw);
	if (!Number.isFinite(depth)) {
		throw new NormalizationError("malformed-or-truncated-json", "Malformed or truncated JSON record", rawLine.line);
	}
	if (depth > maxDepth) {
		throw new NormalizationError("json-depth-limit", `Record exceeds JSON depth ${maxDepth}`, rawLine.line, [String(depth)]);
	}
	if (containsUnsafeInteger(rawLine.raw)) {
		throw new NormalizationError(
			"unsafe-json-integer",
			"Integer exceeds lossless JavaScript range; raw bytes are preserved but semantic conversion is quarantined",
			rawLine.line,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLine.raw);
	} catch (error) {
		throw new NormalizationError(
			"malformed-or-truncated-json",
			error instanceof Error ? error.message : "Malformed JSON record",
			rawLine.line,
		);
	}
	if (!isRecord(parsed)) {
		throw new NormalizationError("non-object-record", "Every migration JSONL record must be an object", rawLine.line);
	}
	if (structuredNodeCount(parsed, maxNodesPerRecord) > maxNodesPerRecord) {
		throw new NormalizationError(
			"record-node-limit",
			`Record exceeds ${maxNodesPerRecord} structural nodes`,
			rawLine.line,
		);
	}
	return parsed;
}

function fallbackTimestamp(item: InventoryItem): string {
	const source = item.original?.modifiedAt;
	return source && Number.isFinite(Date.parse(source)) ? new Date(source).toISOString() : item.snapshotAt;
}

async function probeInput(
	item: InventoryItem,
	lineOptions: Parameters<typeof readBoundedLines>[1],
	maxDepth: number,
	maxNodesPerRecord: number,
): Promise<Probe> {
	let title: string | undefined;
	for await (const rawLine of readBoundedLines(item.copied?.path ?? "", lineOptions)) {
		const record = parseRecord(rawLine, maxDepth, maxNodesPerRecord);
		if (record.type === "title" && typeof record.title === "string") {
			title = record.title;
			continue;
		}
		if (item.classification.format === "omp-jsonl-v3" || item.classification.format === "pi-jsonl-legacy") {
			if (record.type !== "session") return { title };
			return {
				header: record,
				title,
				nativeId: stringField(record, "id"),
				cwd: typeof record.cwd === "string" ? record.cwd : undefined,
				timestamp: validIsoTimestamp(record.timestamp),
			};
		}
		if (item.classification.format === "claude-jsonl") {
			return {
				header: record,
				nativeId: stringField(record, "sessionId") ?? stringField(record, "session_id"),
				cwd: stringField(record, "cwd"),
				timestamp: validIsoTimestamp(record.timestamp) ?? timestampFromNumber(record.timestamp),
			};
		}
		if (item.classification.format === "codex-jsonl" && record.type === "session_meta" && isRecord(record.payload)) {
			return {
				header: record,
				nativeId: stringField(record.payload, "id"),
				cwd: stringField(record.payload, "cwd"),
				timestamp: validIsoTimestamp(record.timestamp) ?? timestampFromNumber(record.timestamp),
			};
		}
		return { header: record, timestamp: validIsoTimestamp(record.timestamp) ?? timestampFromNumber(record.timestamp) };
	}
	return { title };
}

function deterministicId(state: ConversionState, raw: string, line: number, suffix: string): string {
	const base = `mig-${sha256(`${state.originId}\0${line}\0${suffix}\0${raw}`).slice(0, 24)}`;
	let candidate = base;
	let collision = 1;
	while (state.usedIds.has(candidate)) {
		collision += 1;
		candidate = `${base}-${collision}`;
	}
	state.usedIds.add(candidate);
	return candidate;
}

function recordTimestamp(record: Record<string, unknown>, fallback: string): string {
	return validIsoTimestamp(record.timestamp) ?? timestampFromNumber(record.timestamp) ?? fallback;
}

function emptyUsage(): Record<string, unknown> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function entryEnvelope(
	state: ConversionState,
	rawLine: RawLine,
	record: Record<string, unknown>,
	suffix: string,
	type: string,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const id = deterministicId(state, rawLine.raw, rawLine.line, suffix);
	const entry = {
		type,
		id,
		parentId: state.previousId,
		timestamp: recordTimestamp(record, state.timestamp),
		...payload,
	};
	state.previousId = id;
	state.parents.set(id, entry.parentId);
	return entry;
}

function provenanceEntry(state: ConversionState, rawLine: RawLine, record: Record<string, unknown>, note: string): Record<string, unknown> {
	return entryEnvelope(state, rawLine, record, `provenance-${note}`, "custom", {
		customType: "migration.provenance.v1",
		data: {
			note,
			sourceFormat: state.sourceFormat,
			sourceLine: rawLine.line,
			rawSha256: sha256(rawLine.raw),
			rawRecordRef: { itemId: state.item.itemId, line: rawLine.line },
			contextParticipation: false,
		},
	});
}

function textBlocks(value: unknown, acceptedTypes: readonly string[]): Array<Record<string, unknown>> {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [];
	const blocks: Array<Record<string, unknown>> = [];
	for (const block of value) {
		if (!isRecord(block) || typeof block.type !== "string" || !acceptedTypes.includes(block.type)) continue;
		if (typeof block.text === "string") blocks.push({ type: "text", text: block.text });
	}
	return blocks;
}

function claudeEntries(state: ConversionState, rawLine: RawLine, record: Record<string, unknown>): Record<string, unknown>[] {
	if ((record.type !== "user" && record.type !== "assistant") || !isRecord(record.message)) {
		return [provenanceEntry(state, rawLine, record, "unmapped-claude-record")];
	}
	const timestamp = recordTimestamp(record, state.timestamp);
	const entries: Record<string, unknown>[] = [];
	if (record.type === "assistant") {
		const content: Array<Record<string, unknown>> = [];
		if (typeof record.message.content === "string") content.push({ type: "text", text: record.message.content });
		else if (Array.isArray(record.message.content)) {
			for (const block of record.message.content) {
				if (!isRecord(block)) continue;
				if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
				else if (block.type === "thinking" && typeof block.thinking === "string") {
					content.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
				} else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
					state.toolCalls.add(block.id);
					state.toolNames.set(block.id, block.name);
					content.push({
						type: "toolCall",
						id: block.id,
						name: block.name,
						arguments: isRecord(block.input) ? block.input : {},
					});
				}
			}
		}
		if (content.length > 0) {
			const usage = isRecord(record.message.usage) ? record.message.usage : {};
			const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
			const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
			const message = {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: stringField(record.message, "model") ?? "unknown",
				usage: {
					input,
					output,
					cacheRead: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
					cacheWrite: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
					totalTokens: input + output,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: record.message.stop_reason === "tool_use" ? "toolUse" : "stop",
				timestamp: Date.parse(timestamp),
			};
			entries.push(entryEnvelope(state, rawLine, record, "assistant", "message", { message }));
		}
	} else if (Array.isArray(record.message.content)) {
		const userText: Array<Record<string, unknown>> = [];
		let resultIndex = 0;
		for (const block of record.message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") userText.push({ type: "text", text: block.text });
			if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			state.toolResults.add(block.tool_use_id);
			const message = {
				role: "toolResult",
				toolCallId: block.tool_use_id,
				toolName: state.toolNames.get(block.tool_use_id) ?? "unknown",
				content: textBlocks(block.content, ["text"]),
				isError: block.is_error === true,
				timestamp: Date.parse(timestamp),
			};
			entries.push(entryEnvelope(state, rawLine, record, `tool-result-${resultIndex}`, "message", { message }));
			resultIndex += 1;
		}
		if (userText.length > 0) {
			entries.push(
				entryEnvelope(state, rawLine, record, "user", "message", {
					message: { role: "user", content: userText, timestamp: Date.parse(timestamp) },
				}),
			);
		}
	} else if (typeof record.message.content === "string") {
		entries.push(
			entryEnvelope(state, rawLine, record, "user", "message", {
				message: { role: "user", content: record.message.content, timestamp: Date.parse(timestamp) },
			}),
		);
	}
	entries.push(provenanceEntry(state, rawLine, record, entries.length > 0 ? "raw-claude-record" : "unmapped-claude-record"));
	return entries;
}

function codexContent(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	const content: Array<Record<string, unknown>> = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if ((block.type === "input_text" || block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
		}
	}
	return content;
}

function codexEntries(state: ConversionState, rawLine: RawLine, record: Record<string, unknown>): Record<string, unknown>[] {
	if (record.type === "session_meta" || record.type === "turn_context") {
		return [provenanceEntry(state, rawLine, record, String(record.type))];
	}
	const payload = isRecord(record.payload) ? record.payload : undefined;
	if (!payload) return [provenanceEntry(state, rawLine, record, "unmapped-codex-record")];
	const timestamp = recordTimestamp(record, state.timestamp);
	let message: Record<string, unknown> | undefined;
	if (record.type === "response_item" && payload.type === "message") {
		const content = codexContent(payload.content);
		if (content.length > 0 && payload.role === "user") message = { role: "user", content, timestamp: Date.parse(timestamp) };
		else if (content.length > 0 && payload.role === "assistant") {
			message = {
				role: "assistant",
				content,
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "unknown",
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
			};
		}
	} else if (record.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
		const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
		const name = stringField(payload, "name");
		if (callId && name) {
			state.toolCalls.add(callId);
			state.toolNames.set(callId, name);
			let args: unknown = payload.arguments ?? payload.input;
			if (typeof args === "string") {
				try {
					args = JSON.parse(args);
				} catch {
					args = { input: args };
				}
			}
			message = {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name, arguments: isRecord(args) ? args : {} }],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "unknown",
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: Date.parse(timestamp),
			};
		}
	} else if (
		record.type === "response_item" &&
		(payload.type === "function_call_output" || payload.type === "custom_tool_call_output")
	) {
		const callId = stringField(payload, "call_id");
		if (callId) {
			state.toolResults.add(callId);
			message = {
				role: "toolResult",
				toolCallId: callId,
				toolName: state.toolNames.get(callId) ?? "unknown",
				content: typeof payload.output === "string" ? [{ type: "text", text: payload.output }] : [],
				isError: false,
				timestamp: Date.parse(timestamp),
			};
		}
	} else if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
		message = { role: "user", content: payload.message, timestamp: Date.parse(timestamp) };
	} else if (record.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string") {
		message = {
			role: "assistant",
			content: [{ type: "text", text: payload.message }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "unknown",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
		};
	}
	const entries: Record<string, unknown>[] = [];
	if (message) entries.push(entryEnvelope(state, rawLine, record, "message", "message", { message }));
	entries.push(provenanceEntry(state, rawLine, record, message ? "raw-codex-record" : "unmapped-codex-record"));
	return entries;
}

function ompEntry(state: ConversionState, rawLine: RawLine, record: Record<string, unknown>): Record<string, unknown> | undefined {
	if (record.type === "session" || record.type === "title") return undefined;
	if (typeof record.type !== "string") return provenanceEntry(state, rawLine, record, "missing-omp-entry-type");
	if (!KNOWN_OMP_ENTRY_TYPES.has(record.type)) {
		const originalId = stringField(record, "id");
		const id = originalId && !state.usedIds.has(originalId) ? originalId : deterministicId(state, rawLine.raw, rawLine.line, "unknown");
		state.usedIds.add(id);
		const parentId = typeof record.parentId === "string" || record.parentId === null ? record.parentId : state.previousId;
		state.parents.set(id, parentId);
		state.previousId = id;
		return {
			type: "custom",
			id,
			parentId,
			timestamp: recordTimestamp(record, state.timestamp),
			customType: "migration.provenance.v1",
			data: {
				note: "unknown-omp-record",
				sourceLine: rawLine.line,
				originalType: record.type,
				rawSha256: sha256(rawLine.raw),
				rawRecordRef: { itemId: state.item.itemId, line: rawLine.line },
				contextParticipation: false,
			},
		};
	}
	let id = stringField(record, "id");
	if (!id) id = deterministicId(state, rawLine.raw, rawLine.line, String(record.type));
	else if (state.usedIds.has(id)) throw new NormalizationError("duplicate-entry-id", `Duplicate OMP entry id ${id}`, rawLine.line);
	else state.usedIds.add(id);
	const parentId = typeof record.parentId === "string" || record.parentId === null ? record.parentId : state.previousId;
	const normalized: Record<string, unknown> = {
		...record,
		id,
		parentId,
		timestamp: recordTimestamp(record, state.timestamp),
	};
	if (record.type === "message" && isRecord(record.message) && record.message.role === "hookMessage") {
		normalized.message = { ...record.message, role: "custom" };
	}
	state.parents.set(id, parentId);
	state.previousId = id;
	if (record.type === "message" && isRecord(normalized.message)) {
		const message = normalized.message;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") state.toolResults.add(message.toolCallId);
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") state.toolCalls.add(block.id);
			}
		}
	}
	return normalized;
}

function assertGraphAndTools(state: ConversionState): void {
	for (const [id, parent] of state.parents) {
		if (parent !== null && !state.parents.has(parent)) {
			throw new NormalizationError("missing-parent", `Entry ${id} references missing parent ${parent}`);
		}
		const visited = new Set<string>();
		let cursor: string | null = id;
		while (cursor !== null) {
			if (visited.has(cursor)) throw new NormalizationError("cyclic-entry-graph", `Cycle detected at entry ${cursor}`);
			visited.add(cursor);
			cursor = state.parents.get(cursor) ?? null;
		}
	}
	for (const result of state.toolResults) {
		if (!state.toolCalls.has(result)) {
			throw new NormalizationError("orphan-tool-result", `Tool result ${result} has no preserved tool call`);
		}
	}
}

async function assertOwnedDirectoryPath(root: string, targetDirectory: string): Promise<void> {
	const rootStats = await fs.lstat(root);
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
		throw new NormalizationError("unsafe-output-root", "Owned root must be a real directory");
	}
	const relative = path.relative(path.resolve(root), path.resolve(targetDirectory));
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new NormalizationError("output-outside-owned-root", "Output path escaped its caller-owned root");
	}
	let current = path.resolve(root);
	for (const component of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		const stats = await fs.lstat(current);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new NormalizationError("unsafe-output-parent", `Output parent is not a real directory: ${current}`);
		}
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function verifyCopiedInput(item: InventoryItem, backupRoot: string, signal: AbortSignal | undefined): Promise<void> {
	if (!item.copied || !item.original?.sha256) throw new NormalizationError("not-an-immutable-copy", "Input lacks verified copy accounting");
	const backupStats = await fs.lstat(backupRoot);
	if (!backupStats.isDirectory() || backupStats.isSymbolicLink()) {
		throw new NormalizationError("unsafe-backup-root", "Backup root must be a real directory");
	}
	const root = await fs.realpath(backupRoot);
	const copiedPath = await fs.realpath(item.copied.path);
	const relative = path.relative(root, copiedPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new NormalizationError("copy-outside-backup-root", "Normalization input is outside the caller-owned backup root");
	}
	const stats = await fs.lstat(item.copied.path, { bigint: true });
	if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || (stats.mode & 0o222n) !== 0n) {
		throw new NormalizationError("copy-not-immutable-file", "Copied input is not an immutable, singly-linked regular file");
	}
	const handle = await fs.open(item.copied.path, constants.O_RDONLY | constants.O_NOFOLLOW);
	const hasher = createHash("sha256");
	let size = 0n;
	const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	try {
		let position = 0;
		while (true) {
			assertNotAborted(signal);
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
			if (bytesRead === 0) break;
			hasher.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
			size += BigInt(bytesRead);
		}
	} finally {
		await handle.close();
	}
	const digest = hasher.digest("hex");
	if (
		digest !== item.original.sha256 ||
		digest !== item.copied.sha256 ||
		size.toString() !== item.original.size ||
		size.toString() !== item.copied.size
	) {
		throw new NormalizationError("copy-hash-mismatch", "Copied input no longer matches original hash and size", undefined, [digest]);
	}
}

async function hashFile(filePath: string): Promise<{ sha256: string; size: string }> {
	const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	const hasher = createHash("sha256");
	let size = 0n;
	const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	try {
		let position = 0;
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
			if (bytesRead === 0) break;
			hasher.update(buffer.subarray(0, bytesRead));
			size += BigInt(bytesRead);
			position += bytesRead;
		}
	} finally {
		await handle.close();
	}
	return { sha256: hasher.digest("hex"), size: size.toString() };
}


async function recoverPublishedNormalization(
	item: InventoryItem,
	sourceFormat: SourceFormat,
	disposition: Exclude<AdapterDisposition, "quarantined">,
	jsonlPath: string,
	manifestPath: string,
	destinationRoot: string,
): Promise<NormalizedOutput | undefined> {
	let manifestStats;
	try {
		manifestStats = await fs.lstat(manifestPath);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
	if (
		!manifestStats.isFile() ||
		manifestStats.isSymbolicLink() ||
		manifestStats.nlink !== 1 ||
		manifestStats.size > 64 * 1024
	) {
		throw new NormalizationError(
			"unsafe-existing-receipt",
			`Existing normalization receipt is not a safe bounded file: ${manifestPath}`,
		);
	}
	await assertOwnedDirectoryPath(destinationRoot, path.dirname(manifestPath));
	const handle = await fs.open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
	} catch (error) {
		throw new NormalizationError(
			"invalid-existing-receipt",
			error instanceof Error ? error.message : `Invalid normalization receipt: ${manifestPath}`,
		);
	} finally {
		await handle.close();
	}
	if (!isRecord(parsed) || !isRecord(parsed.output)) {
		throw new NormalizationError("invalid-existing-receipt", `Invalid normalization receipt: ${manifestPath}`);
	}
	const output = parsed.output;
	const expectedJsonlPath = `sessions/${path.basename(jsonlPath)}`;
	const expectedManifestPath = `sessions/${path.basename(manifestPath)}`;
	const records = output.records;
	const size = output.size;
	if (
		parsed.schemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
		parsed.itemId !== item.itemId ||
		parsed.sourceNamespace !== item.sourceNamespace ||
		parsed.sourceFormat !== sourceFormat ||
		parsed.sourceSha256 !== item.original?.sha256 ||
		output.jsonlPath !== expectedJsonlPath ||
		output.manifestPath !== expectedManifestPath ||
		output.disposition !== disposition ||
		typeof output.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(output.sha256) ||
		typeof size !== "string" ||
		!/^(?:0|[1-9]\d*)$/.test(size) ||
		typeof records !== "number" ||
		!Number.isSafeInteger(records) ||
		records < 1 ||
		typeof output.originId !== "string" ||
		typeof output.sourceAlias !== "string"
	) {
		throw new NormalizationError(
			"existing-normalization-receipt-mismatch",
			`Existing receipt does not match inventory item ${item.itemId}`,
		);
	}
	const outputStats = await fs.lstat(jsonlPath).catch(() => undefined);
	if (!outputStats?.isFile() || outputStats.isSymbolicLink() || outputStats.nlink !== 1) {
		throw new NormalizationError("unsafe-existing-output", `Existing normalized output is not a safe regular file: ${jsonlPath}`);
	}
	const digest = await hashFile(jsonlPath);
	if (digest.sha256 !== output.sha256 || digest.size !== size) {
		throw new NormalizationError(
			"existing-normalization-output-mismatch",
			`Existing normalized output does not match its receipt: ${jsonlPath}`,
		);
	}
	return {
		jsonlPath,
		manifestPath,
		sha256: output.sha256,
		size,
		records,
		disposition,
		originId: output.originId,
		sourceAlias: output.sourceAlias,
	};
}


async function publishExistingFileNoClobber(
	temporary: string,
	filePath: string,
	ownedRoot: string,
): Promise<"published" | "identical"> {
	await assertOwnedDirectoryPath(ownedRoot, path.dirname(filePath));
	try {
		await fs.link(temporary, filePath);
		await fs.rm(temporary);
		await syncDirectory(path.dirname(filePath));
		return "published";
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		const stats = await fs.lstat(filePath);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			throw new NormalizationError("unsafe-existing-output", `Existing output is not a safe regular file: ${filePath}`);
		}
		const [temporaryHash, existingHash] = await Promise.all([hashFile(temporary), hashFile(filePath)]);
		if (temporaryHash.sha256 !== existingHash.sha256 || temporaryHash.size !== existingHash.size) {
			throw new NormalizationError("idempotent-output-collision", `Refusing to clobber different output at ${filePath}`);
		}
		await fs.rm(temporary);
		return "identical";
	}
}

async function publishText(filePath: string, content: string, ownedRoot: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await assertOwnedDirectoryPath(ownedRoot, path.dirname(filePath));
	const temporary = `${filePath}.partial-${crypto.randomUUID()}`;
	const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	const bytes = Buffer.from(content);
	try {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
			if (result.bytesWritten === 0) throw new Error(`Short write while publishing ${filePath}`);
			offset += result.bytesWritten;
		}
		await handle.sync();
		await handle.close();
		await publishExistingFileNoClobber(temporary, filePath, ownedRoot);
	} catch (error) {
		await handle.close().catch(() => undefined);
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

async function publishJson(filePath: string, value: unknown, ownedRoot: string): Promise<void> {
	await publishText(filePath, `${canonicalJson(value)}\n`, ownedRoot);
}

async function normalizeItem(
	item: InventoryItem,
	options: Required<
		Pick<
			NormalizeInventoryOptions,
			"maxRecordBytes" | "maxTotalBytes" | "maxRecords" | "maxDepth" | "maxOutputBytes" | "maxNodesPerRecord"
		>
	> &
		Pick<NormalizeInventoryOptions, "backupRoot" | "destinationRoot" | "signal">,
): Promise<NormalizationResult> {
	const adapter = adapterForFormat(item.classification.format);
	if (item.status !== "copied" || !item.copied) {
		return {
			schemaVersion: NORMALIZATION_SCHEMA_VERSION,
			itemId: item.itemId,
			sourceNamespace: item.sourceNamespace,
			sourceFormat: item.classification.format,
			sourceSha256: item.original?.sha256,
			status: "skipped",
			disposition: {
				code: "inventory-item-not-copied",
				reason: "Only a byte-verified caller-owned copy can be normalized",
				evidence: [item.status, item.disposition?.code ?? "no-disposition"],
			},
		};
	}
	if (!adapter?.normalizable) {
		return {
			schemaVersion: NORMALIZATION_SCHEMA_VERSION,
			itemId: item.itemId,
			sourceNamespace: item.sourceNamespace,
			sourceFormat: item.classification.format,
			sourceSha256: item.original?.sha256,
			status: "skipped",
			disposition: {
				code: "archive-copy-only",
				reason: "No semantic adapter is registered; immutable bytes remain preserved",
				evidence: item.classification.evidence,
			},
		};
	}
	const sessionsDirectory = path.join(options.destinationRoot, "sessions");
	const jsonlPath = path.join(sessionsDirectory, `${item.itemId}.jsonl`);
	const manifestPath = path.join(sessionsDirectory, `${item.itemId}.manifest.json`);
	const temporary = `${jsonlPath}.partial-${crypto.randomUUID()}`;
	try {
		await verifyCopiedInput(item, options.backupRoot, options.signal);
		const recovered = await recoverPublishedNormalization(
			item,
			item.classification.format,
			adapter.disposition,
			jsonlPath,
			manifestPath,
			options.destinationRoot,
		);
		if (recovered) {
			return {
				schemaVersion: NORMALIZATION_SCHEMA_VERSION,
				itemId: item.itemId,
				sourceNamespace: item.sourceNamespace,
				sourceFormat: item.classification.format,
				sourceSha256: item.original?.sha256,
				status: "normalized",
				output: recovered,
				disposition: {
					code: adapter.disposition,
					reason: `Normalized with ${adapter.id}; no tool action was executed`,
					evidence: [recovered.sha256, `records=${recovered.records}`],
				},
			};
		}
		const lineOptions = {
			maxRecordBytes: options.maxRecordBytes,
			maxTotalBytes: options.maxTotalBytes,
			maxRecords: options.maxRecords,
			signal: options.signal,
		};
		const probe = await probeInput(item, lineOptions, options.maxDepth, options.maxNodesPerRecord);
		if (
			(item.classification.format === "omp-jsonl-v3" || item.classification.format === "pi-jsonl-legacy") &&
			(!probe.header || probe.header.type !== "session" || !probe.nativeId)
		) {
			throw new NormalizationError("invalid-session-header", "OMP/pi input has no valid leading session header");
		}
		const nativeId = probe.nativeId ?? `content-${item.original?.sha256?.slice(0, 24)}`;
		const originId = `origin_${sha256(`${item.sourceNamespace}\0${nativeId}`).slice(0, 40)}`;
		const sourceAlias = `${item.sourceNamespace}:${nativeId}`;
		const timestamp = probe.timestamp ?? fallbackTimestamp(item);
		const headerId = probe.nativeId ?? `session_${sha256(sourceAlias).slice(0, 24)}`;
		const state: ConversionState = {
			item,
			sourceFormat: item.classification.format,
			originId,
			sourceAlias,
			timestamp,
			usedIds: new Set(),
			parents: new Map(),
			toolCalls: new Set(),
			toolResults: new Set(),
			toolNames: new Map(),
			previousId: null,
			recordsWritten: 0,
		};
		await fs.mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
		await assertOwnedDirectoryPath(options.destinationRoot, sessionsDirectory);
		const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		const outputHasher = createHash("sha256");
		let outputBytes = 0n;
		let outputPosition = 0;
		const writeRecord = async (record: Record<string, unknown>): Promise<void> => {
			const bytes = Buffer.from(`${canonicalJson(record)}\n`);
			if (bytes.byteLength > options.maxRecordBytes) {
				throw new NormalizationError("normalized-record-byte-limit", "Normalized record exceeds configured byte limit");
			}
			if (outputBytes + BigInt(bytes.byteLength) > BigInt(options.maxOutputBytes)) {
				throw new NormalizationError("normalized-output-byte-limit", "Normalized output exceeds configured byte limit");
			}
			let offset = 0;
			while (offset < bytes.byteLength) {
				const result = await handle.write(bytes, offset, bytes.byteLength - offset, outputPosition);
				if (result.bytesWritten === 0) throw new NormalizationError("normalized-short-write", "Normalized output short write");
				offset += result.bytesWritten;
				outputPosition += result.bytesWritten;
			}
			outputHasher.update(bytes);
			outputBytes += BigInt(bytes.byteLength);
			state.recordsWritten += 1;
		};
		try {
			const header: Record<string, unknown> =
				probe.header && (item.classification.format === "omp-jsonl-v3" || item.classification.format === "pi-jsonl-legacy")
					? {
							...probe.header,
							type: "session",
							version: CURRENT_SESSION_VERSION,
							id: headerId,
							timestamp,
							cwd: probe.cwd ?? "",
							...(probe.title ? { title: probe.title } : {}),
						}
					: {
							type: "session",
							version: CURRENT_SESSION_VERSION,
							id: headerId,
							timestamp,
							cwd: probe.cwd ?? "",
						};
			await writeRecord(header);
			const provenanceId = `migration-${sha256(`${originId}\0${item.original?.sha256}`).slice(0, 24)}`;
			state.usedIds.add(provenanceId);
			state.parents.set(provenanceId, null);
			await writeRecord({
				type: "custom",
				id: provenanceId,
				parentId: null,
				timestamp,
				customType: "migration.provenance.v1",
				data: {
					origin_id: originId,
					source_alias: sourceAlias,
					sourceNamespace: item.sourceNamespace,
					sourceSha256: item.original?.sha256,
					sourceSize: item.original?.size,
					adapterId: adapter.id,
					adapterVersion: NORMALIZATION_SCHEMA_VERSION,
					disposition: adapter.disposition,
					rawBackupItemId: item.itemId,
					contextParticipation: false,
					toolExecution: "never-replayed",
				},
			});
			if (item.classification.format !== "omp-jsonl-v3" && item.classification.format !== "pi-jsonl-legacy") {
				state.previousId = provenanceId;
			}
			for await (const rawLine of readBoundedLines(item.copied.path, lineOptions)) {
				assertNotAborted(options.signal);
				const record = parseRecord(rawLine, options.maxDepth, options.maxNodesPerRecord);
				let entries: Record<string, unknown>[];
				if (item.classification.format === "claude-jsonl") entries = claudeEntries(state, rawLine, record);
				else if (item.classification.format === "codex-jsonl") entries = codexEntries(state, rawLine, record);
				else if (item.classification.format === "generic-jsonl") {
					entries = [provenanceEntry(state, rawLine, record, "uninterpreted-json-record")];
				} else {
					const entry = ompEntry(state, rawLine, record);
					entries = entry ? [entry] : [];
				}
				for (const entry of entries) await writeRecord(entry);
			}
			assertGraphAndTools(state);
			await handle.sync();
			await handle.close();
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}
		const digest = outputHasher.digest("hex");
		let first = true;
		let malformed = 0;
		let validatedRecords = 0;
		await visitEntriesFromFileStream(
			temporary,
			entry => {
				if (first) {
					first = false;
					if (entry.type !== "session" || entry.version !== CURRENT_SESSION_VERSION) {
						throw new NormalizationError("omp-validation-failed", "Normalized output has no OMP v3 header");
					}
				}
				validatedRecords += 1;
			},
			{ onMalformedRecord: () => (malformed += 1), maxBytes: options.maxTotalBytes },
		);
		if (malformed > 0 || validatedRecords !== state.recordsWritten) {
			throw new NormalizationError("omp-validation-failed", "OMP streaming parser rejected normalized output", undefined, [
				`malformed=${malformed}`,
				`expected=${state.recordsWritten}`,
				`actual=${validatedRecords}`,
			]);
		}
		await publishExistingFileNoClobber(temporary, jsonlPath, options.destinationRoot);
		const output: NormalizedOutput = {
			jsonlPath,
			manifestPath,
			sha256: digest,
			size: outputBytes.toString(),
			records: state.recordsWritten,
			disposition: adapter.disposition,
			originId,
			sourceAlias,
		};
		await publishJson(
			manifestPath,
			{
				schemaVersion: NORMALIZATION_SCHEMA_VERSION,
				itemId: item.itemId,
				sourceNamespace: item.sourceNamespace,
				sourceFormat: item.classification.format,
				sourceSha256: item.original?.sha256,
				sourceSize: item.original?.size,
				output: {
					...output,
					jsonlPath: `sessions/${path.basename(jsonlPath)}`,
					manifestPath: `sessions/${path.basename(manifestPath)}`,
				},
			},
			options.destinationRoot,
		);
		return {
			schemaVersion: NORMALIZATION_SCHEMA_VERSION,
			itemId: item.itemId,
			sourceNamespace: item.sourceNamespace,
			sourceFormat: item.classification.format,
			sourceSha256: item.original?.sha256,
			status: "normalized",
			output,
			disposition: {
				code: adapter.disposition,
				reason: `Normalized with ${adapter.id}; no tool action was executed`,
				evidence: [digest, `records=${state.recordsWritten}`],
			},
		};
	} catch (error) {
		await fs.rm(temporary, { force: true });
		const normalizedError =
			error instanceof NormalizationError
				? error
				: new NormalizationError("normalization-failed", error instanceof Error ? error.message : String(error));
		return {
			schemaVersion: NORMALIZATION_SCHEMA_VERSION,
			itemId: item.itemId,
			sourceNamespace: item.sourceNamespace,
			sourceFormat: item.classification.format,
			sourceSha256: item.original?.sha256,
			status: "quarantined",
			quarantine: {
				code: normalizedError.code,
				reason: normalizedError.message,
				line: normalizedError.line,
				evidence: normalizedError.evidence,
			},
			disposition: {
				code: "quarantined",
				reason: normalizedError.message,
				evidence: [normalizedError.code, ...(normalizedError.line ? [`line=${normalizedError.line}`] : [])],
			},
		};
	}
}

/** Normalize every explicitly supplied, byte-verified inventory copy into deterministic OMP v3 files. */
export async function normalizeCopiedInventory(
	inventory: InventoryManifest,
	options: NormalizeInventoryOptions,
): Promise<NormalizationManifest> {
	if (!path.isAbsolute(options.backupRoot) || !path.isAbsolute(options.destinationRoot)) {
		throw new Error("backupRoot and destinationRoot must be absolute");
	}
	await assertOwnedDirectoryPath(options.destinationRoot, options.destinationRoot);
	const resolvedOptions = {
		...options,
		maxRecordBytes: Math.max(1024, options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES),
		maxTotalBytes: Math.max(1024, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES),
		maxRecords: Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS),
		maxDepth: Math.max(4, options.maxDepth ?? DEFAULT_MAX_DEPTH),
		maxOutputBytes: Math.max(1024, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
		maxNodesPerRecord: Math.max(16, options.maxNodesPerRecord ?? DEFAULT_MAX_NODES_PER_RECORD),
	};
	const results: NormalizationResult[] = [];
	for (const item of [...inventory.items].sort((left, right) => left.itemId.localeCompare(right.itemId, "en"))) {
		assertNotAborted(options.signal);
		results.push(await normalizeItem(item, resolvedOptions));
	}
	const aggregate = createHash("sha256");
	for (const result of results) {
		aggregate.update(
			`${result.itemId}\0${result.status}\0${result.output?.sha256 ?? result.quarantine?.code ?? result.disposition.code}\n`,
		);
	}
	const manifest: NormalizationManifest = {
		schemaVersion: NORMALIZATION_SCHEMA_VERSION,
		inventoryAggregateSha256: inventory.summary.aggregateSha256,
		sourceSnapshotAt: inventory.snapshotAt,
		results,
		summary: {
			supplied: results.length,
			normalized: results.filter(result => result.status === "normalized").length,
			skipped: results.filter(result => result.status === "skipped").length,
			quarantined: results.filter(result => result.status === "quarantined").length,
			aggregateSha256: aggregate.digest("hex"),
		},
	};
	await publishJson(
		path.join(options.destinationRoot, "normalization-manifest.json"),
		{
			...manifest,
			results: manifest.results.map(result => ({
				...result,
				output: result.output
					? {
							...result.output,
							jsonlPath: `sessions/${path.basename(result.output.jsonlPath)}`,
							manifestPath: `sessions/${path.basename(result.output.manifestPath)}`,
						}
					: undefined,
			})),
		},
		options.destinationRoot,
	);
	const quarantine = manifest.results
		.filter((result): result is NormalizationResult & { quarantine: NormalizationQuarantine } => result.status === "quarantined")
		.map(result => canonicalJson({ itemId: result.itemId, sourceSha256: result.sourceSha256, quarantine: result.quarantine }))
		.join("\n");
	const quarantinePath = path.join(options.destinationRoot, "quarantine.jsonl");
	const quarantineContent = quarantine ? `${quarantine}\n` : "";
	await publishText(quarantinePath, quarantineContent, options.destinationRoot);
	return manifest;
}
