import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "../../session/session-entries";
import { buildSessionContext } from "../../session/session-context";
import { parseSessionContent } from "../../session/session-loader";
import { semanticHash } from "./canonical";
import { normalizeSessionFile } from "./normalize";

const fixtureRoot = path.join(import.meta.dir, "__fixtures__");
const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map(file => fs.rm(file, { force: true })));
});

async function temporaryJsonl(records: readonly Record<string, unknown>[]): Promise<string> {
	const file = path.join(os.tmpdir(), `omp-normalize-${crypto.randomUUID()}.jsonl`);
	await Bun.write(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	temporaryPaths.push(file);
	return file;
}

async function normalizeFixture(name: string) {
	return normalizeSessionFile({
		inputPath: path.join(fixtureRoot, name),
		sourceNamespace: `fixture:${name}`,
	});
}

function contextFromBundle(jsonl: string, leafId: string | null) {
	const parsed = parseSessionContent(jsonl);
	const entries = parsed.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	return buildSessionContext(entries, leafId, undefined, { transcript: true });
}

describe("WCDB migration normalization", () => {
	it("normalizes every discovered harness version into parser-valid deterministic OMP bundles", async () => {
		const cases = [
			["omp-v1.jsonl", "omp-v1", "resumable"],
			["omp-v2.jsonl", "omp-v2", "resumable"],
			["omp-v3.jsonl", "omp-v3", "resumable"],
			["claude.jsonl", "claude-jsonl", "resumable-with-mapping"],
			["codex.jsonl", "codex-rollout-jsonl", "resumable-with-mapping"],
			["jcode.jsonl", "jcode-session-json", "resumable-with-mapping"],
		] as const;
		for (const [fixture, format, disposition] of cases) {
			const first = await normalizeFixture(fixture);
			const second = await normalizeFixture(fixture);
			expect(first.manifest.format).toBe(format);
			expect(first.manifest.disposition).toBe(disposition);
			expect(first.manifest).toEqual(second.manifest);
			expect(first.jsonl).toBe(second.jsonl);
			expect(first.manifest.event_hashes).toEqual(second.manifest.event_hashes);
			expect(first.manifest.version_id).toBe(second.manifest.version_id);
			const parsed = parseSessionContent(first.jsonl);
			expect(parsed.invalidHeader).toBe(false);
			expect(parsed.malformedRecords).toBe(0);
			expect(parsed.entries[0]).toMatchObject({ type: "session", version: 3 });
			expect(first.manifest.context_hash).not.toBeNull();
			expect(first.objects.filter(object => object.ref.startsWith("raw/sha256/")).length).toBe(
				first.manifest.source_records,
			);
		}
	});

	it("preserves paired tool messages, multimodal attachments, usage, titles, and foreign provenance", async () => {
		const claude = await normalizeFixture("claude.jsonl");
		const codex = await normalizeFixture("codex.jsonl");
		for (const bundle of [claude, codex]) {
			const context = contextFromBundle(bundle.jsonl, bundle.manifest.selected_leaf_id);
			const calls = new Set<string>();
			const results = new Set<string>();
			for (const message of context.messages) {
				if (message.role === "assistant") {
					for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
				} else if (message.role === "toolResult") results.add(message.toolCallId);
			}
			expect(calls).toEqual(results);
			expect(bundle.manifest.attachments).toHaveLength(1);
			expect(bundle.records.some(record => record.type === "title_change")).toBe(true);
			expect(
				bundle.records.some(record => record.type === "custom" && record.customType === "migration.provenance.v1"),
			).toBe(true);
		}
		const claudeAssistant = claude.records.find(
			record => record.type === "message" && record.message.role === "assistant" && record.message.usage.input === 10,
		);
		expect(claudeAssistant).toBeDefined();
	});

	it("quarantines cyclic and missing-parent OMP graphs instead of letting the context builder truncate them", async () => {
		const cycle = await temporaryJsonl([
			{ type: "session", version: 3, id: "cycle", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/workspace" },
			{ type: "message", id: "a", parentId: "b", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "a", timestamp: 1 } },
			{ type: "message", id: "b", parentId: "a", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "user", content: "b", timestamp: 2 } },
		]);
		const missing = await temporaryJsonl([
			{ type: "session", version: 3, id: "missing", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/workspace" },
			{ type: "message", id: "child", parentId: "absent", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "child", timestamp: 1 } },
		]);
		const cycleBundle = await normalizeSessionFile({ inputPath: cycle, sourceNamespace: "fixture:cycle" });
		const missingBundle = await normalizeSessionFile({ inputPath: missing, sourceNamespace: "fixture:missing" });
		expect(cycleBundle.manifest.disposition).toBe("quarantined");
		expect(cycleBundle.manifest.diagnostics.some(diagnostic => diagnostic.code === "cycle")).toBe(true);
		expect(missingBundle.manifest.disposition).toBe("quarantined");
		expect(missingBundle.manifest.diagnostics.some(diagnostic => diagnostic.code === "missing-parent")).toBe(true);
	});

	it("streams to explicit byte and record limits and returns a disposition for oversized input", async () => {
		const oversized = await temporaryJsonl([
			{ type: "session", version: 3, id: "large", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/workspace" },
			{ type: "message", id: "large-message", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "x".repeat(4096), timestamp: 1 } },
		]);
		const bundle = await normalizeSessionFile({
			inputPath: oversized,
			sourceNamespace: "fixture:oversized",
			limits: { inputBytes: 512, recordBytes: 256, records: 10 },
		});
		expect(bundle.manifest.disposition).toBe("quarantined");
		expect(
			bundle.manifest.diagnostics.some(
				diagnostic => diagnostic.code === "input-byte-limit" || diagnostic.code === "record-byte-limit",
			),
		).toBe(true);
		expect(bundle.jsonl).toBe("");
	});

	it("preserves unknown control events only as non-context custom records", async () => {
		const file = await temporaryJsonl([
			{ type: "session_meta", timestamp: "2025-01-01T00:00:00.000Z", payload: { id: "unknown-control", cwd: "/workspace" } },
			{ type: "event_msg", timestamp: "2025-01-01T00:00:01.000Z", payload: { type: "future_control", message: "must not become a user prompt" } },
		]);
		const bundle = await normalizeSessionFile({ inputPath: file, sourceNamespace: "fixture:unknown-control" });
		expect(bundle.manifest.disposition).toBe("archive-only");
		expect(
			bundle.records.some(
				record => record.type === "custom" && record.customType === "migration.unknown.codex.v1",
			),
		).toBe(true);
		const context = contextFromBundle(bundle.jsonl, bundle.manifest.selected_leaf_id);
		expect(context.messages).toEqual([]);
	});

	it("canonical hashes sort object keys while distinguishing absent, null, exact integers, and binary bytes", () => {
		expect(semanticHash({ a: 1, b: 2 })).toBe(semanticHash({ b: 2, a: 1 }));
		expect(semanticHash({ value: undefined })).not.toBe(semanticHash({}));
		expect(semanticHash({ value: undefined })).not.toBe(semanticHash({ value: null }));
		expect(semanticHash({ value: 9_007_199_254_740_993n })).not.toBe(
			semanticHash({ value: 9_007_199_254_740_992n }),
		);
		expect(semanticHash({ value: Uint8Array.of(0, 1, 2) })).not.toBe(
			semanticHash({ value: Uint8Array.of(0, 1, 3) }),
		);
	});
});
