import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

const timestamp = "2026-09-15T12:00:00.000Z";
const assistantUsage: AssistantMessage["usage"] = {
	input: 3,
	output: 2,
	cacheRead: 1,
	cacheWrite: 0,
	totalTokens: 6,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const payloadFixture = new Uint8Array([0, 1, 2, 255, 128, 13, 10, 42]);
const payloadFixtureSha256 = "afca51f96113269865b8da9d9ceba62c058acf512072edc7191358ba3c6206f5";


function normalizedFixture(): { content: string; entries: SessionEntry[]; header: SessionHeader } {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "native-session-duplicate-safe",
		timestamp,
		cwd: "/team-fixture/project",
		previousSessionFiles: ["/read-only-source/original.jsonl"],
	};
	const entries = [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "inspect the payload", timestamp: 1 },
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Reading it." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "payload.bin" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "fixture-model",
				usage: assistantUsage,
				stopReason: "toolUse",
				timestamp: 2,
			} satisfies AssistantMessage,
		},
		{
			type: "message",
			id: "tool-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "payload-body" }],
				isError: false,
				timestamp: 3,
			},
		},
		{
			type: "custom",
			id: "provenance-1",
			parentId: "tool-1",
			timestamp,
			customType: "migration.provenance.v1",
			data: {
				origin_id: "origin:fixture:one",
				source_alias: "fixture-install/native-session-duplicate-safe",
				raw_sha256: "f".repeat(64),
			},
		},
		{
			type: "label",
			id: "label-1",
			parentId: "provenance-1",
			timestamp,
			targetId: "tool-1",
			label: "verified-payload",
		},
		{
			type: "title_change",
			id: "title-1",
			parentId: "label-1",
			timestamp,
			title: "Fixture title v2",
			previousTitle: "Fixture title",
			source: "user",
		},
		{
			type: "message",
			id: "sibling-user",
			parentId: "user-1",
			timestamp,
			message: { role: "user", content: "divergent sibling", timestamp: 4 },
		},
	] satisfies SessionEntry[];
	const content = [
		serializeTitleSlot({ title: "Fixture title", source: "user", updatedAt: timestamp }).trimEnd(),
		JSON.stringify(header),
		...entries.map(entry => JSON.stringify(entry)),
		"",
	].join("\n");
	return { content, entries, header };
}

function semanticProjection(entries: readonly FileEntry[]): unknown {
	return entries.map(entry => {
		if (entry.type === "session") {
			return {
				type: entry.type,
				version: entry.version,
				id: entry.id,
				title: entry.title,
				titleSource: entry.titleSource,
				cwd: entry.cwd,
				previousSessionFiles: entry.previousSessionFiles,
			};
		}
		return entry;
	});
}

describe("Turso migration JSONL differential baseline", () => {
	it("folds the mutable title slot without losing graph, provenance, title history, or sibling branches", () => {
		const fixture = normalizedFixture();
		const loaded = parseSessionContent(fixture.content);

		expect(loaded.invalidHeader).toBe(false);
		expect(loaded.malformedRecords).toBe(0);
		expect(loaded.titleSlot).toEqual({ title: "Fixture title", source: "user", updatedAt: timestamp });
		expect(semanticProjection(loaded.entries)).toEqual(
			semanticProjection([{ ...fixture.header, title: "Fixture title", titleSource: "user" }, ...fixture.entries]),
		);
	});

	it("builds only the selected branch while preserving paired tool messages and excluding non-context provenance", () => {
		const { content } = normalizedFixture();
		const loaded = parseSessionContent(content);
		const entries = loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const context = buildSessionContext(entries, "title-1");

		expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(context.messages.some(message => JSON.stringify(message).includes("migration.provenance.v1"))).toBe(false);
		expect(context.messages.some(message => JSON.stringify(message).includes("divergent sibling"))).toBe(false);
		const assistant = context.messages.find(message => message.role === "assistant");
		const toolResult = context.messages.find(message => message.role === "toolResult");
		expect(assistant?.content).toContainEqual({
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "payload.bin" },
		});
		expect(toolResult).toMatchObject({ toolCallId: "call-1", toolName: "read", isError: false });
	});

	it("pins the exact binary payload bytes used by repository round-trip gates", () => {
		const digest = new Bun.CryptoHasher("sha256").update(payloadFixture).digest("hex");

		expect(payloadFixture).toEqual(new Uint8Array([0, 1, 2, 255, 128, 13, 10, 42]));
		expect(digest).toBe(payloadFixtureSha256);
	});

	it("surfaces malformed input accounting instead of treating skipped bytes as a complete clean session", () => {
		const fixture = normalizedFixture();
		const firstNewline = fixture.content.indexOf("\n");
		const withMalformedRecord = `${fixture.content.slice(0, firstNewline + 1)}{not-json}\n${fixture.content.slice(firstNewline + 1)}`;
		const loaded = parseSessionContent(withMalformedRecord);

		expect(loaded.malformedRecords).toBe(1);
		expect(loaded.invalidHeader).toBe(false);
		expect(loaded.entries[0]?.type).toBe("session");
	});
});
