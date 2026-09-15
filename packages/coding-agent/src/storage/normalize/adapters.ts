import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	CompactionEntry,
	CustomEntry,
	FileEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionHeader,
	SessionMessageEntry,
	SessionTitleSlotEntry,
} from "../../session/session-entries";
import { semanticHash, sha256Bytes } from "./canonical";
import type {
	AdapterInputRecord,
	AdapterOutput,
	AttachmentReference,
	HarnessFormat,
	NormalizationDiagnostic,
	PreservedObject,
} from "./types";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const OMP_ENTRY_KEYS: Record<string, readonly string[]> = {
	message: ["type", "id", "parentId", "timestamp", "message"],
	model_usage: ["type", "id", "parentId", "timestamp", "purpose", "role", "api", "provider", "model", "usage", "stopReason", "errorMessage"],
	thinking_level_change: ["type", "id", "parentId", "timestamp", "thinkingLevel", "configured"],
	model_change: ["type", "id", "parentId", "timestamp", "model", "role", "resolvedModelIsFallback", "provider", "modelId"],
	service_tier_change: ["type", "id", "parentId", "timestamp", "serviceTier"],
	compaction: ["type", "id", "parentId", "timestamp", "summary", "shortSummary", "firstKeptEntryId", "firstKeptEntryIndex", "tokensBefore", "tokensAfter", "method", "providerReplayThroughEntryId", "details", "preserveData", "fromExtension", "warning"],
	branch_summary: ["type", "id", "parentId", "timestamp", "fromId", "summary", "details", "fromExtension"],
	custom: ["type", "id", "parentId", "timestamp", "customType", "data"],
	custom_message: ["type", "id", "parentId", "timestamp", "customType", "content", "details", "display", "attribution"],
	label: ["type", "id", "parentId", "timestamp", "targetId", "label"],
	title_change: ["type", "id", "parentId", "timestamp", "title", "previousTitle", "source", "trigger"],
	ttsr_injection: ["type", "id", "parentId", "timestamp", "injectedRules"],
	session_init: ["type", "id", "parentId", "timestamp", "systemPrompt", "task", "tools", "agent", "modelRole", "resolvedModel", "readOnly", "outputSchema", "outputSchemaMode", "restrictToolNames", "spawns", "readSummarize", "advisor"],
	mode_change: ["type", "id", "parentId", "timestamp", "mode", "data"],
	credential_pin: ["type", "id", "parentId", "timestamp", "provider", "hash"],
	reset_boundary: ["type", "id", "parentId", "timestamp"],
};

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampMillis(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function isoTimestamp(value: unknown, fallback: number): string {
	return new Date(timestampMillis(value, fallback)).toISOString();
}

function stableId(namespace: string, line: number, suffix: string): string {
	return `${namespace}-${semanticHash({ line, suffix }).slice(-16)}`;
}

function uniqueId(base: string, used: Set<string>): string {
	let candidate = base;
	let ordinal = 1;
	while (used.has(candidate)) {
		ordinal += 1;
		candidate = `${base}-${ordinal}`;
	}
	used.add(candidate);
	return candidate;
}

function assistantMessage(
	content: AssistantMessage["content"],
	timestamp: number,
	provider: string,
	api: string,
	model: string,
	stopReason: AssistantMessage["stopReason"],
	usage: Usage = EMPTY_USAGE,
): AssistantMessage {
	return { role: "assistant", content, api, provider, model, usage, stopReason, timestamp };
}

function decodeInlineImage(image: ImageContent): { reference: AttachmentReference; object: PreservedObject } | undefined {
	if (image.data.startsWith("blob:sha256:")) return undefined;
	if (
		image.data.length === 0 ||
		image.data.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
	) {
		return undefined;
	}
	try {
		const bytes = Buffer.from(image.data, "base64");
		const sha256 = sha256Bytes(bytes);
		const ref = `attachments/sha256/${sha256}`;
		return {
			reference: { sha256, ref, byteLength: bytes.byteLength, mediaType: image.mimeType, encoding: "base64" },
			object: { ref, mediaType: image.mimeType, bytes },
		};
	} catch {
		return undefined;
	}
}

function collectAttachments(entries: readonly SessionEntry[]): {
	attachments: AttachmentReference[];
	objects: PreservedObject[];
	diagnostics: NormalizationDiagnostic[];
} {
	const attachments: AttachmentReference[] = [];
	const objects: PreservedObject[] = [];
	const diagnostics: NormalizationDiagnostic[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || !("content" in entry.message)) continue;
		const content = typeof entry.message.content === "string" ? [] : entry.message.content;
		for (const block of content) {
			if (block.type !== "image") continue;
			if (block.data.startsWith("blob:sha256:")) {
				diagnostics.push({
					code: "missing-critical-payload",
					entryId: entry.id,
					detail: `External attachment ${block.data} is not present in the source JSONL bundle`,
				});
				continue;
			}
			const decoded = decodeInlineImage(block);
			if (!decoded) {
				diagnostics.push({
					code: "missing-critical-payload",
					entryId: entry.id,
					detail: `Inline ${block.mimeType} attachment is not valid base64`,
				});
				continue;
			}
			if (seen.has(decoded.reference.sha256)) continue;
			seen.add(decoded.reference.sha256);
			attachments.push(decoded.reference);
			objects.push(decoded.object);
		}
	}
	return { attachments, objects, diagnostics };
}

function validateGraph(entries: readonly SessionEntry[], selectedLeafId: string | null): NormalizationDiagnostic[] {
	const diagnostics: NormalizationDiagnostic[] = [];
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (byId.has(entry.id)) {
			diagnostics.push({ code: "duplicate-id", entryId: entry.id, detail: `Duplicate entry id ${entry.id}` });
			continue;
		}
		byId.set(entry.id, entry);
	}
	for (const entry of entries) {
		if (entry.parentId && !byId.has(entry.parentId)) {
			diagnostics.push({
				code: "missing-parent",
				entryId: entry.id,
				detail: `Entry ${entry.id} references missing parent ${entry.parentId}`,
			});
		}
		const seen = new Set<string>();
		let cursor: SessionEntry | undefined = entry;
		while (cursor) {
			if (seen.has(cursor.id)) {
				diagnostics.push({ code: "cycle", entryId: entry.id, detail: `Parent cycle reaches ${cursor.id}` });
				break;
			}
			seen.add(cursor.id);
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
	}
	if (selectedLeafId && !byId.has(selectedLeafId)) {
		diagnostics.push({
			code: "missing-critical-payload",
			entryId: selectedLeafId,
			detail: `Selected leaf ${selectedLeafId} does not exist`,
		});
	}

	const calls = new Set<string>();
	const results = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) if (block.type === "toolCall") calls.add(block.id);
		} else if (entry.message.role === "toolResult") {
			results.add(entry.message.toolCallId);
		}
	}
	for (const call of calls) {
		if (!results.has(call)) diagnostics.push({ code: "unpaired-tool-call", detail: `Tool call ${call} has no result` });
	}
	for (const result of results) {
		if (!calls.has(result)) diagnostics.push({ code: "unpaired-tool-result", detail: `Tool result ${result} has no call` });
	}
	return diagnostics;
}

function unknownCustom(
	harness: string,
	record: AdapterInputRecord,
	unknownFields: readonly string[],
	parentId: string | null,
	used: Set<string>,
): CustomEntry {
	return {
		type: "custom",
		customType: `migration.unknown.${harness}.v1`,
		data: {
			recordType: typeof record.value.type === "string" ? record.value.type : null,
			rawRecordRef: record.ref.ref,
			unknownFields: [...unknownFields].sort(),
		},
		id: uniqueId(stableId(harness, record.line, `unknown:${unknownFields.join(",")}`), used),
		parentId,
		timestamp: isoTimestamp(record.value.timestamp, record.line),
	};
}

function finalizeAdapter(output: AdapterOutput): AdapterOutput {
	const attachments = collectAttachments(output.entries);
	output.attachments.push(...attachments.attachments);
	output.objects.push(...attachments.objects);
	output.diagnostics.push(...attachments.diagnostics, ...validateGraph(output.entries, output.selectedLeafId));
	return output;
}

export function detectHarness(records: readonly AdapterInputRecord[]): HarnessFormat {
	const first = records[0]?.value;
	const next = first?.type === "title" ? records[1]?.value : first;
	if (next?.type === "session") {
		const version = typeof next.version === "number" ? next.version : 1;
		if (version === 1) return "omp-v1";
		if (version === 2) return "omp-v2";
		if (version === 3) return "omp-v3";
		return "unknown";
	}
	if (
		next &&
		typeof next.id === "string" &&
		Array.isArray(next.messages) &&
		(typeof next.working_dir === "string" || typeof next.created_at === "string" || typeof next.created_at === "number")
	) {
		return "jcode-session-json";
	}
	if (records.some(record => record.value.type === "session_meta" && isRecord(record.value.payload))) {
		return "codex-rollout-jsonl";
	}
	if (records.some(record => record.value.type === "user" || record.value.type === "assistant")) {
		return "claude-jsonl";
	}
	return "unknown";
}

function adaptOmp(records: readonly AdapterInputRecord[], format: "omp-v1" | "omp-v2" | "omp-v3"): AdapterOutput {
	const dataRecords = records[0]?.value.type === "title" ? records.slice(1) : records;
	const slot = records[0]?.value.type === "title" ? (records[0].value as unknown as SessionTitleSlotEntry) : undefined;
	const rawHeader = dataRecords[0]?.value;
	if (!rawHeader || rawHeader.type !== "session") throw new Error("OMP session header is missing");
	const nativeSessionId = stringField(rawHeader, "id");
	const timestamp = stringField(rawHeader, "timestamp");
	const cwd = stringField(rawHeader, "cwd");
	if (!nativeSessionId || !timestamp || !cwd) throw new Error("OMP session header lacks id, timestamp, or cwd");
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: nativeSessionId,
		timestamp,
		cwd,
	};
	if (typeof rawHeader.title === "string") header.title = rawHeader.title;
	if (rawHeader.titleSource === "auto" || rawHeader.titleSource === "user") header.titleSource = rawHeader.titleSource;
	if (Array.isArray(rawHeader.additionalDirectories) && rawHeader.additionalDirectories.every(item => typeof item === "string")) {
		header.additionalDirectories = rawHeader.additionalDirectories;
	}
	if (typeof rawHeader.parentSession === "string") header.parentSession = rawHeader.parentSession;
	if (Array.isArray(rawHeader.previousSessionFiles) && rawHeader.previousSessionFiles.every(item => typeof item === "string")) {
		header.previousSessionFiles = rawHeader.previousSessionFiles;
	}
	if (typeof rawHeader.providerPromptCacheKey === "string") header.providerPromptCacheKey = rawHeader.providerPromptCacheKey;

	const used = new Set<string>();
	const entries: SessionEntry[] = [];
	const unknowns: Array<{ record: AdapterInputRecord; fields: string[] }> = [];
	let previous: string | null = null;
	for (let index = 1; index < dataRecords.length; index++) {
		const record = dataRecords[index];
		const value = { ...record.value };
		const type = stringField(value, "type");
		const knownKeys = type ? OMP_ENTRY_KEYS[type] : undefined;
		if (!type || !knownKeys) {
			unknowns.push({ record, fields: Object.keys(value) });
			continue;
		}
		const id = format === "omp-v1" ? uniqueId(stableId("omp", record.line, type), used) : stringField(value, "id");
		if (!id) throw new Error(`OMP ${type} record at line ${record.line} lacks an id`);
		if (format !== "omp-v1") used.add(id);
		value.id = id;
		value.parentId = format === "omp-v1" ? previous : value.parentId === null ? null : stringField(value, "parentId") ?? null;
		value.timestamp = stringField(value, "timestamp") ?? new Date(record.line).toISOString();
		if (type === "message" && isRecord(value.message) && value.message.role === "hookMessage") value.message.role = "custom";
		if (type === "model_change" && typeof value.model !== "string") {
			const provider = stringField(value, "provider");
			const modelId = stringField(value, "modelId");
			if (provider && modelId) value.model = `${provider}/${modelId}`;
		}
		if (type === "compaction" && format === "omp-v1" && typeof value.firstKeptEntryIndex === "number") {
			const target = entries[value.firstKeptEntryIndex - 1];
			if (target) value.firstKeptEntryId = target.id;
			delete value.firstKeptEntryIndex;
		}
		if (type === "message" && !isRecord(value.message)) throw new Error(`OMP message ${id} lacks message payload`);
		entries.push(value as unknown as SessionEntry);
		previous = id;
		const unknownFields = Object.keys(record.value).filter(key => !knownKeys.includes(key));
		if (unknownFields.length > 0) unknowns.push({ record, fields: unknownFields });
	}
	let selectedLeafId = entries.at(-1)?.id ?? null;
	for (const unknown of unknowns) {
		const custom = unknownCustom("omp", unknown.record, unknown.fields, selectedLeafId, used);
		entries.push(custom);
		selectedLeafId = custom.id;
	}
	const output: AdapterOutput = {
		format,
		header,
		entries,
		selectedLeafId,
		nativeSessionId,
		title: slot
			? { title: slot.title, source: slot.source, updatedAt: slot.updatedAt }
			: { title: header.title ?? "", source: header.titleSource, updatedAt: header.timestamp },
		disposition: "resumable",
		reasons: [format === "omp-v3" ? "Native OMP v3 semantics validated" : `${format} deterministically migrated to OMP v3`],
		diagnostics: [],
		attachments: [],
		objects: [],
	};
	return finalizeAdapter(output);
}

function claudeImage(value: unknown): ImageContent | undefined {
	if (!isRecord(value) || value.type !== "image" || !isRecord(value.source)) return undefined;
	const data = stringField(value.source, "data");
	const mimeType = stringField(value.source, "media_type");
	return data && mimeType ? { type: "image", data, mimeType } : undefined;
}

function claudeBlocks(value: unknown, toolNames: Map<string, string>): AssistantMessage["content"] {
	if (!Array.isArray(value)) return [];
	const content: AssistantMessage["content"] = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else if (block.type === "thinking" && typeof block.thinking === "string") {
			const thinking: ThinkingContent = { type: "thinking", thinking: block.thinking };
			if (typeof block.signature === "string") thinking.thinkingSignature = block.signature;
			content.push(thinking);
		} else if (block.type === "tool_use") {
			const id = stringField(block, "id");
			const name = stringField(block, "name");
			if (!id || !name) continue;
			toolNames.set(id, name);
			content.push({ type: "toolCall", id, name, arguments: isRecord(block.input) ? block.input : {} });
		}
	}
	return content;
}

function claudeUserContent(value: unknown): string | Array<TextContent | ImageContent> | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const content: Array<TextContent | ImageContent> = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else {
			const image = claudeImage(block);
			if (image) content.push(image);
		}
	}
	return content.length > 0 ? content : undefined;
}

function claudeUsage(value: unknown): Usage {
	if (!isRecord(value)) return EMPTY_USAGE;
	const input = finiteNumber(value, "input_tokens") ?? 0;
	const output = finiteNumber(value, "output_tokens") ?? 0;
	const cacheRead = finiteNumber(value, "cache_read_input_tokens") ?? 0;
	const cacheWrite = finiteNumber(value, "cache_creation_input_tokens") ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function adaptClaude(records: readonly AdapterInputRecord[], fallbackCwd: string | undefined): AdapterOutput {
	const nativeSessionId = records.map(record => stringField(record.value, "sessionId")).find(Boolean) ??
		records.map(record => stringField(record.value, "uuid")).find(Boolean) ?? "unknown";
	const sourceParents = new Map<string, string | null>();
	let cwd = fallbackCwd;
	let title: { title: string; source: "auto" | "user"; updatedAt: string } | undefined;
	for (const record of records) {
		const uuid = stringField(record.value, "uuid");
		if (uuid) sourceParents.set(uuid, stringField(record.value, "parentUuid") ?? null);
		cwd ??= stringField(record.value, "cwd");
		if (record.value.type === "custom-title" && typeof record.value.customTitle === "string") {
			title = { title: record.value.customTitle, source: "user", updatedAt: isoTimestamp(record.value.timestamp, record.line) };
		} else if (!title && record.value.type === "ai-title" && typeof record.value.aiTitle === "string") {
			title = { title: record.value.aiTitle, source: "auto", updatedAt: isoTimestamp(record.value.timestamp, record.line) };
		}
	}
	for (const [sourceId, sourceParent] of sourceParents) {
		if (sourceParent && !sourceParents.has(sourceParent)) {
			throw new Error(`Claude record ${sourceId} references missing parent ${sourceParent}`);
		}
		const seen = new Set<string>();
		let cursor: string | null | undefined = sourceId;
		while (cursor) {
			if (seen.has(cursor)) throw new Error(`Claude parent cycle reaches ${cursor}`);
			seen.add(cursor);
			cursor = sourceParents.get(cursor);
		}
	}
	if (!cwd) throw new Error("Claude transcript has no cwd and no explicit fallback mapping");

	const headerTimestamp = isoTimestamp(records[0]?.value.timestamp, 0);
	const header: SessionHeader = { type: "session", version: 3, id: nativeSessionId, timestamp: headerTimestamp, cwd };
	if (title) {
		header.title = title.title;
		header.titleSource = title.source;
	}
	const used = new Set<string>();
	const entries: SessionEntry[] = [];
	const tails = new Map<string, string>();
	const toolNames = new Map<string, string>();
	const unknowns: AdapterInputRecord[] = [];
	let lastModel: string | undefined;

	for (const record of records) {
		const value = record.value;
		if (value.type !== "user" && value.type !== "assistant") {
			if (value.type !== "custom-title" && value.type !== "ai-title") unknowns.push(record);
			continue;
		}
		if (value.isSidechain === true || value.isMeta === true) {
			unknowns.push(record);
			continue;
		}
		const sourceId = stringField(value, "uuid");
		if (!sourceId || !isRecord(value.message)) throw new Error(`Claude record at line ${record.line} lacks uuid or message`);
		const sourceParent = stringField(value, "parentUuid");
		if (sourceParent && !tails.has(sourceParent)) {
			throw new Error(`Claude record ${sourceId} cannot map parent ${sourceParent}`);
		}
		let parentId = sourceParent ? tails.get(sourceParent) ?? null : null;
		const timestampMsValue = timestampMillis(value.timestamp, record.line);
		const timestamp = new Date(timestampMsValue).toISOString();
		if (value.type === "assistant") {
			const model = stringField(value.message, "model") ?? "unknown";
			if (model !== lastModel) {
				const id = uniqueId(stableId("claude", record.line, `${sourceId}:model`), used);
				const modelEntry: ModelChangeEntry = { type: "model_change", id, parentId, timestamp, model: `anthropic/${model}` };
				entries.push(modelEntry);
				parentId = id;
				lastModel = model;
			}
			const content = claudeBlocks(value.message.content, toolNames);
			const errorMessage = stringField(value, "error");
			if (content.length === 0 && !errorMessage) throw new Error(`Claude assistant ${sourceId} has no content`);
			const stop = value.message.stop_reason;
			const stopReason: AssistantMessage["stopReason"] = stop === "tool_use" ? "toolUse" : stop === "max_tokens" ? "length" : stop == null || stop === "end_turn" || stop === "stop_sequence" || stop === "pause_turn" ? "stop" : "error";
			const message = assistantMessage(content, timestampMsValue, "anthropic", "anthropic-messages", model, stopReason, claudeUsage(value.message.usage));
			const responseId = stringField(value.message, "id");
			if (responseId) message.responseId = responseId;
			if (errorMessage) message.errorMessage = errorMessage;
			const id = uniqueId(stableId("claude", record.line, `${sourceId}:message`), used);
			entries.push({ type: "message", id, parentId, timestamp, message });
			parentId = id;
		} else {
			const rawContent = value.message.content;
			const toolResults: ToolResultMessage[] = [];
			if (Array.isArray(rawContent)) {
				for (const block of rawContent) {
					if (!isRecord(block) || block.type !== "tool_result") continue;
					const callId = stringField(block, "tool_use_id");
					if (!callId) throw new Error(`Claude tool result at line ${record.line} lacks tool_use_id`);
					const resultContent = typeof block.content === "string" ? [{ type: "text" as const, text: block.content }] : claudeUserContent(block.content);
					toolResults.push({
						role: "toolResult",
						toolCallId: callId,
						toolName: toolNames.get(callId) ?? "unknown",
						content: typeof resultContent === "string" || resultContent === undefined ? [] : resultContent,
						isError: block.is_error === true,
						timestamp: timestampMsValue,
					});
				}
			}
			if (toolResults.length > 0) {
				for (let index = 0; index < toolResults.length; index++) {
					const id = uniqueId(stableId("claude", record.line, `${sourceId}:tool:${index}`), used);
					entries.push({ type: "message", id, parentId, timestamp, message: toolResults[index] });
					parentId = id;
				}
			} else {
				const content = claudeUserContent(rawContent);
				if (content === undefined || content === "") throw new Error(`Claude user ${sourceId} has no content`);
				const message: UserMessage = { role: "user", content, timestamp: timestampMsValue };
				const id = uniqueId(stableId("claude", record.line, `${sourceId}:message`), used);
				entries.push({ type: "message", id, parentId, timestamp, message });
				parentId = id;
			}
		}
		if (!parentId) throw new Error(`Claude record ${sourceId} produced no resumable entry`);
		tails.set(sourceId, parentId);
	}
	let selectedLeafId = entries.at(-1)?.id ?? null;
	for (const record of unknowns) {
		const custom = unknownCustom("claude", record, Object.keys(record.value), selectedLeafId, used);
		entries.push(custom);
		selectedLeafId = custom.id;
	}
	const output: AdapterOutput = {
		format: "claude-jsonl",
		header,
		entries,
		selectedLeafId,
		nativeSessionId,
		title,
		disposition: unknowns.length > 0 ? "archive-only" : "resumable-with-mapping",
		reasons: unknowns.length > 0
			? ["Unknown Claude control records are preserved outside model context"]
			: ["Workspace, model, and tool mappings must be confirmed before continuation"],
		diagnostics: unknowns.map(record => ({ code: "unknown-control-event", line: record.line, detail: `Preserved Claude ${String(record.value.type)} record outside context` })),
		attachments: [],
		objects: [],
	};
	return finalizeAdapter(output);
}

function responseContent(value: unknown): Array<TextContent | ImageContent> {
	if (!Array.isArray(value)) return [];
	const content: Array<TextContent | ImageContent> = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const type = stringField(item, "type");
		const text = stringField(item, "text");
		if ((type === "input_text" || type === "output_text" || type === "text") && text !== undefined) {
			content.push({ type: "text", text });
		} else if (type === "input_image" && typeof item.image_url === "string") {
			const match = /^data:([^;,]+);base64,(.+)$/s.exec(item.image_url);
			if (match) content.push({ type: "image", mimeType: match[1], data: match[2] });
		}
	}
	return content;
}

function toolArguments(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {
			return { input: value };
		}
		return { input: value };
	}
	return {};
}

function toolOutput(value: unknown): Array<TextContent | ImageContent> {
	const structured = responseContent(value);
	if (structured.length > 0) return structured;
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (value === undefined) return [];
	return [{ type: "text", text: JSON.stringify(value) }];
}

function adaptCodex(records: readonly AdapterInputRecord[], fallbackCwd: string | undefined): AdapterOutput {
	const metadata = records.find(record => record.value.type === "session_meta" && isRecord(record.value.payload));
	if (!metadata || !isRecord(metadata.value.payload)) throw new Error("Codex rollout lacks session_meta payload");
	const nativeSessionId = stringField(metadata.value.payload, "id");
	const cwd = stringField(metadata.value.payload, "cwd") ?? fallbackCwd;
	if (!nativeSessionId || !cwd) throw new Error("Codex session_meta lacks id or cwd mapping");
	const headerTimestamp = isoTimestamp(metadata.value.timestamp ?? metadata.value.payload.timestamp, 0);
	const header: SessionHeader = { type: "session", version: 3, id: nativeSessionId, timestamp: headerTimestamp, cwd };
	const entries: SessionEntry[] = [];
	const used = new Set<string>();
	const toolNames = new Map<string, string>();
	const unknowns: AdapterInputRecord[] = [];
	let parentId: string | null = null;
	let model = "codex";
	let title: { title: string; source: "auto"; updatedAt: string } | undefined;

	const appendMessage = (record: AdapterInputRecord, message: UserMessage | AssistantMessage | ToolResultMessage, suffix: string): void => {
		const id = uniqueId(stableId("codex", record.line, suffix), used);
		const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp: isoTimestamp(record.value.timestamp, record.line), message };
		entries.push(entry);
		parentId = id;
	};
	const appendCall = (record: AdapterInputRecord, call: ToolCall, suffix: string): void => {
		toolNames.set(call.id, call.name);
		appendMessage(record, assistantMessage([call], timestampMillis(record.value.timestamp, record.line), "openai-codex", "openai-codex-responses", model, "toolUse"), suffix);
	};

	for (const record of records) {
		const value = record.value;
		if (value.type === "session_meta") continue;
		if (value.type === "turn_context" && isRecord(value.payload)) {
			const nextModel = stringField(value.payload, "model");
			if (nextModel && nextModel !== model) {
				model = nextModel;
				const id = uniqueId(stableId("codex", record.line, "model"), used);
				const entry: ModelChangeEntry = { type: "model_change", id, parentId, timestamp: isoTimestamp(value.timestamp, record.line), model: `openai-codex/${model}` };
				entries.push(entry);
				parentId = id;
			}
			continue;
		}
		if (value.type === "compacted" && isRecord(value.payload)) {
			const summary = stringField(value.payload, "message")?.trim() || "Context compacted by Codex.";
			const replacement = Array.isArray(value.payload.replacement_history) && value.payload.replacement_history.every(isRecord) ? value.payload.replacement_history : undefined;
			if (!summary && !replacement) throw new Error(`Codex compaction at line ${record.line} lacks payload`);
			const id = uniqueId(stableId("codex", record.line, "compaction"), used);
			const preserveData = replacement ? { openaiRemoteCompaction: { provider: "openai-codex", replacementHistory: replacement } } : undefined;
			const entry: CompactionEntry = { type: "compaction", id, parentId, timestamp: isoTimestamp(value.timestamp, record.line), summary, shortSummary: "Imported Codex compaction", firstKeptEntryId: id, tokensBefore: 0, preserveData };
			entries.push(entry);
			parentId = id;
			continue;
		}
		if (!isRecord(value.payload)) {
			unknowns.push(record);
			continue;
		}
		const payload = value.payload;
		const kind = stringField(payload, "type");
		const timestamp = timestampMillis(value.timestamp, record.line);
		if (value.type === "response_item") {
			if (kind === "message") {
				const content = responseContent(payload.content);
				if (content.length === 0) throw new Error(`Codex message at line ${record.line} has no content`);
				if (payload.role === "user") appendMessage(record, { role: "user", content, timestamp }, "user");
				else if (payload.role === "assistant") appendMessage(record, assistantMessage(content, timestamp, "openai-codex", "openai-codex-responses", model, "stop"), "assistant");
				else unknowns.push(record);
				continue;
			}
			if (kind === "reasoning") {
				const content: ThinkingContent[] = [];
				for (const key of ["summary", "content"]) {
					const blocks = payload[key];
					if (!Array.isArray(blocks)) continue;
					for (const block of blocks) if (isRecord(block) && typeof block.text === "string") content.push({ type: "thinking", thinking: block.text });
				}
				if (content.length > 0) appendMessage(record, assistantMessage(content, timestamp, "openai-codex", "openai-codex-responses", model, "stop"), "reasoning");
				else unknowns.push(record);
				continue;
			}
			if (kind === "function_call" || kind === "custom_tool_call") {
				const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
				const name = stringField(payload, "name");
				if (!callId || !name) throw new Error(`Codex tool call at line ${record.line} lacks id or name`);
				appendCall(record, { type: "toolCall", id: callId, name, arguments: toolArguments(kind === "custom_tool_call" ? payload.input : payload.arguments), customWireName: kind === "custom_tool_call" ? name : undefined }, "tool-call");
				continue;
			}
			if (kind === "function_call_output" || kind === "custom_tool_call_output") {
				const callId = stringField(payload, "call_id");
				if (!callId) throw new Error(`Codex tool output at line ${record.line} lacks call_id`);
				appendMessage(record, { role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId) ?? "unknown", content: toolOutput(payload.output), isError: false, timestamp }, "tool-result");
				continue;
			}
			if (kind === "web_search_call" || kind === "tool_search_call") {
				const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
				if (!callId) throw new Error(`Codex search call at line ${record.line} lacks id`);
				const name = kind === "web_search_call" ? "web_search" : "tool_search";
				appendCall(record, { type: "toolCall", id: callId, name, arguments: toolArguments(kind === "web_search_call" ? payload.action : payload.arguments) }, "search-call");
				continue;
			}
			if (kind === "tool_search_output") {
				const callId = stringField(payload, "call_id");
				if (!callId) throw new Error(`Codex search output at line ${record.line} lacks call_id`);
				appendMessage(record, { role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId) ?? "tool_search", content: toolOutput(payload.tools), isError: payload.status === "failed", timestamp }, "search-result");
				continue;
			}
			unknowns.push(record);
			continue;
		}
		if (value.type === "event_msg") {
			if (kind === "thread_name_updated" && typeof payload.thread_name === "string") {
				title = { title: payload.thread_name, source: "auto", updatedAt: isoTimestamp(value.timestamp, record.line) };
				continue;
			}
			if (kind === "web_search_end") {
				const callId = stringField(payload, "call_id");
				if (!callId) throw new Error(`Codex web search result at line ${record.line} lacks call_id`);
				if (!toolNames.has(callId)) appendCall(record, { type: "toolCall", id: callId, name: "web_search", arguments: toolArguments(payload.action ?? payload.query) }, "web-search-call");
				appendMessage(record, { role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId) ?? "web_search", content: toolOutput(payload.results ?? payload.query), isError: false, timestamp }, "web-search-result");
				continue;
			}
			unknowns.push(record);
			continue;
		}
		unknowns.push(record);
	}
	if (title) {
		header.title = title.title;
		header.titleSource = title.source;
	}
	let selectedLeafId = parentId;
	for (const record of unknowns) {
		const custom = unknownCustom("codex", record, Object.keys(record.value), selectedLeafId, used);
		entries.push(custom);
		selectedLeafId = custom.id;
	}
	const output: AdapterOutput = {
		format: "codex-rollout-jsonl",
		header,
		entries,
		selectedLeafId,
		nativeSessionId,
		title,
		disposition: unknowns.length > 0 ? "archive-only" : "resumable-with-mapping",
		reasons: unknowns.length > 0
			? ["Unknown Codex control records are preserved outside model context"]
			: ["Workspace, model, and tool mappings must be confirmed before continuation"],
		diagnostics: unknowns.map(record => ({ code: "unknown-control-event", line: record.line, detail: `Preserved Codex ${String(record.value.type)} record outside context` })),
		attachments: [],
		objects: [],
	};
	return finalizeAdapter(output);
}

function jcodeContent(value: unknown): string | Array<TextContent | ImageContent> | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const content: Array<TextContent | ImageContent> = [];
	for (const block of value) {
		if (typeof block === "string") {
			content.push({ type: "text", text: block });
			continue;
		}
		if (!isRecord(block)) continue;
		if ((block.type === "text" || block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
			continue;
		}
		const inline = claudeImage(block);
		if (inline) {
			content.push(inline);
			continue;
		}
		const data = stringField(block, "data");
		const mimeType = stringField(block, "mimeType") ?? stringField(block, "media_type");
		if (block.type === "image" && data && mimeType) content.push({ type: "image", data, mimeType });
	}
	return content.length > 0 ? content : undefined;
}

function adaptJcode(records: readonly AdapterInputRecord[], fallbackCwd: string | undefined): AdapterOutput {
	const source = records[0];
	if (!source || records.length !== 1) throw new Error("JCode session must be one JSON object");
	const nativeSessionId = stringField(source.value, "id");
	const cwd = stringField(source.value, "working_dir") ?? fallbackCwd;
	const messages = source.value.messages;
	if (!nativeSessionId || !cwd || !Array.isArray(messages)) {
		throw new Error("JCode session lacks id, working_dir mapping, or messages");
	}
	const created = isoTimestamp(source.value.created_at, 0);
	const header: SessionHeader = { type: "session", version: 3, id: nativeSessionId, timestamp: created, cwd };
	const provider = stringField(source.value, "provider_key") ?? "jcode";
	const model = stringField(source.value, "model") ?? "unknown";
	const entries: SessionEntry[] = [];
	const used = new Set<string>();
	const toolNames = new Map<string, string>();
	const unknownFields: string[] = Object.keys(source.value).filter(
		key =>
			!["created_at", "env_snapshots", "id", "messages", "model", "parent_id", "provider_key", "working_dir"].includes(
				key,
			),
	);
	let parentId: string | null = null;
	let fallbackTimestamp = timestampMillis(source.value.created_at, 0);

	for (let index = 0; index < messages.length; index++) {
		const rawMessage = messages[index];
		if (!isRecord(rawMessage)) throw new Error(`JCode message ${index} is not an object`);
		const role = stringField(rawMessage, "role");
		const timestamp = timestampMillis(rawMessage.timestamp ?? rawMessage.created_at, fallbackTimestamp + index + 1);
		const entryTimestamp = new Date(timestamp).toISOString();
		const id = uniqueId(stableId("jcode", source.line, `message:${index}:${role ?? "unknown"}`), used);
		let message: UserMessage | AssistantMessage | ToolResultMessage | undefined;
		if (role === "user") {
			const content = jcodeContent(rawMessage.content);
			if (content === undefined || content === "") throw new Error(`JCode user message ${index} has no content`);
			message = { role: "user", content, timestamp };
		} else if (role === "assistant") {
			const content: AssistantMessage["content"] = [];
			const visible = jcodeContent(rawMessage.content);
			if (typeof visible === "string") content.push({ type: "text", text: visible });
			else if (visible) content.push(...visible);
			if (Array.isArray(rawMessage.tool_calls)) {
				for (const rawCall of rawMessage.tool_calls) {
					if (!isRecord(rawCall)) continue;
					const callId = stringField(rawCall, "id");
					const fn = isRecord(rawCall.function) ? rawCall.function : rawCall;
					const name = stringField(fn, "name");
					if (!callId || !name) throw new Error(`JCode assistant tool call ${index} lacks id or name`);
					toolNames.set(callId, name);
					content.push({
						type: "toolCall",
						id: callId,
						name,
						arguments: toolArguments(fn.arguments ?? rawCall.arguments),
					});
				}
			}
			if (content.length === 0) throw new Error(`JCode assistant message ${index} has no content`);
			const usage = isRecord(rawMessage.usage)
				? {
						...EMPTY_USAGE,
						input: finiteNumber(rawMessage.usage, "input_tokens") ?? finiteNumber(rawMessage.usage, "input") ?? 0,
						output: finiteNumber(rawMessage.usage, "output_tokens") ?? finiteNumber(rawMessage.usage, "output") ?? 0,
					}
				: EMPTY_USAGE;
			usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			message = assistantMessage(
				content,
				timestamp,
				provider,
				stringField(rawMessage, "api") ?? "openai-completions",
				stringField(rawMessage, "model") ?? model,
				content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
				usage,
			);
		} else if (role === "tool" || role === "toolResult") {
			const callId = stringField(rawMessage, "tool_call_id") ?? stringField(rawMessage, "toolCallId");
			if (!callId) throw new Error(`JCode tool result ${index} lacks tool call id`);
			const content = jcodeContent(rawMessage.content);
			message = {
				role: "toolResult",
				toolCallId: callId,
				toolName: toolNames.get(callId) ?? stringField(rawMessage, "name") ?? "unknown",
				content:
					typeof content === "string"
						? [{ type: "text", text: content }]
						: content ?? [],
				isError: rawMessage.is_error === true || rawMessage.isError === true,
				timestamp,
			};
		} else {
			unknownFields.push(`messages[${index}].role:${role ?? "missing"}`);
			continue;
		}
		const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp: entryTimestamp, message };
		entries.push(entry);
		parentId = id;
	}

	if (isRecord(source.value.env_snapshots)) unknownFields.push("env_snapshots");
	if (typeof source.value.parent_id === "string") unknownFields.push("parent_id");
	if (unknownFields.length > 0) {
		const custom = unknownCustom("jcode", source, unknownFields, parentId, used);
		entries.push(custom);
		parentId = custom.id;
	}
	const output: AdapterOutput = {
		format: "jcode-session-json",
		header,
		entries,
		selectedLeafId: parentId,
		nativeSessionId,
		disposition: unknownFields.some(field => field.startsWith("messages[")) ? "archive-only" : "resumable-with-mapping",
		reasons: unknownFields.some(field => field.startsWith("messages["))
			? ["Unknown JCode roles are preserved outside model context"]
			: ["Workspace, provider, model, tool, environment, and parent-session mappings must be confirmed"],
		diagnostics: unknownFields
			.filter(field => field.startsWith("messages["))
			.map(field => ({ code: "unknown-control-event", detail: `Preserved ${field} outside context` })),
		attachments: [],
		objects: [],
	};
	return finalizeAdapter(output);
}

export function adaptRecords(
	format: Exclude<HarnessFormat, "unknown">,
	records: readonly AdapterInputRecord[],
	fallbackCwd?: string,
): AdapterOutput {
	if (format === "omp-v1" || format === "omp-v2" || format === "omp-v3") return adaptOmp(records, format);
	if (format === "claude-jsonl") return adaptClaude(records, fallbackCwd);
	if (format === "codex-rollout-jsonl") return adaptCodex(records, fallbackCwd);
	if (format === "jcode-session-json") return adaptJcode(records, fallbackCwd);
	throw new Error("OpenCode SQLite requires a supported immutable snapshot adapter");
}
