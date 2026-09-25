/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	buildContextManifest,
	type ContextBreakdown,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
	estimateContextManifest,
	renderContextUsage,
} from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { loadEntriesFromFile } from "../../src/session/session-loader";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tokenizer = new Tokenizer();

describe("per-call context manifest", () => {
	it("keeps each tool and message estimate separate from normalized provider usage", () => {
		const tools = [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
			{
				name: "search",
				description: "Find text",
				parameters: { type: "object", properties: { query: { type: "string" } } },
			},
		];
		const session = {
			systemPrompt: ["base instructions", "workspace context"],
			agent: { state: { tools } },
			skills: [],
		};
		const messages = [
			{ role: "user", content: "find it", timestamp: 1 },
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "call-1",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 2,
			},
		] as never;
		const usage = {
			input: 13,
			cacheRead: 37,
			cacheWrite: 5,
			output: 11,
			reasoningTokens: 4,
			totalTokens: 66,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const manifest = buildContextManifest(estimateContextManifest(session as never, messages, tokenizer), usage);
		expect(manifest.estimated.basis).toBe("provider-bound-context");
		expect(manifest.estimated.tools.map(tool => tool.name)).toEqual(["read", "search"]);
		expect(manifest.estimated.tools[0]?.description).toBe("Read a file");
		expect(manifest.estimated.tools[0]?.schema).toContain("path");
		expect(manifest.estimated.systemParts?.map(part => part.text)).toEqual([
			"base instructions",
			"workspace context",
		]);
		expect(
			manifest.estimated.tools.every(
				tool => tool.totalTokens === tool.nameTokens + tool.descriptionTokens + tool.schemaTokens,
			),
		).toBe(true);
		expect(manifest.estimated.toolSchemaTokens).toBe(estimateToolSchemaTokens(tools as never, tokenizer));
		expect(manifest.estimated.tools.reduce((sum, tool) => sum + tool.totalTokens, 0)).toBe(
			manifest.estimated.toolSchemaTokens,
		);
		expect(manifest.estimated.messages.map(message => [message.role, message.toolName])).toEqual([
			["user", undefined],
			["toolResult", "read"],
		]);
		expect(manifest.estimated.messageTokens).toBe(tokenizer.countMessages(messages));
		expect(manifest.estimated.totalTokens).toBe(
			computeNonMessageTokens(session as never, tokenizer) + manifest.estimated.messageTokens,
		);
		expect(manifest.provider).toEqual({
			source: "normalized-provider-usage",
			inputTokens: 13,
			cacheReadTokens: 37,
			cacheWriteTokens: 5,
			outputTokens: 11,
			reasoningTokens: 4,
			promptTokens: 55,
		});
		expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
		expect(buildContextManifest(manifest.estimated, usage, "/profile/raw-calls/call.jsonl").wire).toEqual({
			source: "outbound-payload-hook",
			tracePath: "/profile/raw-calls/call.jsonl",
		});
	});

	it("uses the provider context anchor when reported and does not infer reasoning", () => {
		const manifest = buildContextManifest(estimateContextManifest({ systemPrompt: ["prompt"] }, [], tokenizer), {
			input: 0,
			cacheRead: 10,
			cacheWrite: 0,
			output: 3,
			contextTokens: 8,
			totalTokens: 13,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(manifest.provider.promptTokens).toBe(8);
		expect(manifest.provider.reasoningTokens).toBeUndefined();
	});

	it("survives journal persistence on an assistant message", async () => {
		using temp = TempDir.createSync("@omp-context-manifest-");
		const manager = SessionManager.create(temp.path(), `${temp.path()}/sessions`);
		const usage = {
			input: 2,
			cacheRead: 3,
			cacheWrite: 0,
			output: 4,
			totalTokens: 9,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const manifest = buildContextManifest(
			estimateContextManifest({ systemPrompt: ["instructions"] }, [], tokenizer),
			usage,
		);
		manager.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			content: [{ type: "text", text: "done" }],
			usage,
			stopReason: "stop",
			timestamp: 1,
			contextSnapshot: { promptTokens: 5, nonMessageTokens: manifest.estimated.totalTokens, manifest },
		} as never);
		await manager.flush();
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		const entries = await loadEntriesFromFile(file!);
		const saved = entries.find(entry => entry.type === "message" && entry.message.role === "assistant");
		expect(
			saved?.type === "message" && saved.message.role === "assistant"
				? saved.message.contextSnapshot?.manifest
				: undefined,
		).toEqual(manifest);
	});

	it("records a distinct prepared context for each AgentSession model call", async () => {
		const mock = createMockModel({
			responses: [
				{ content: ["ok"], usage: { input: 3 } },
				{ content: ["again"], usage: { input: 6 } },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["base"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const manager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
		});
		try {
			await session.prompt("hello");
			await session.prompt("more");
			const manifests = manager
				.getBranch()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.contextSnapshot?.manifest
						? [entry.message.contextSnapshot.manifest]
						: [],
				);
			expect(manifests).toHaveLength(2);
			expect(manifests[0].estimated.basis).toBe("provider-bound-context");
			expect(manifests[0].estimated.messages.some(message => message.role === "user")).toBe(true);
			expect(manifests[1].estimated.messages.length).toBeGreaterThan(manifests[0].estimated.messages.length);
			expect(manifests.map(manifest => manifest.provider.inputTokens)).toEqual([3, 6]);
		} finally {
			await session.dispose();
		}
	});

	it("links a real AgentSession call to its complete outbound and event trace", async () => {
		using temp = TempDir.createSync("@omp-session-wire-");
		const manager = SessionManager.create(temp.path(), `${temp.path()}/sessions`);
		const mock = createMockModel({ responses: [{ content: ["ok"], usage: { input: 7 }, delayMs: 5 }] });
		let sawPayloadHook = false;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["exact prompt"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (model, context, options) => {
				sawPayloadHook = Boolean(options?.onPayload);
				void Promise.resolve(options?.onPayload?.({ instructions: "exact prompt", input: context.messages, tools: [] }, model))
					.then(() => options?.onSseEvent?.({ event: "response.output_text.delta", data: "ok", raw: ["data: ok"] }, model));
				return mock.stream(model, context, options);
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
		});
		try {
			await session.prompt("hello");
			await manager.flush();
			expect(sawPayloadHook).toBe(true);
			const manifest = manager.getBranch().flatMap(entry =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.contextSnapshot?.manifest
					? [entry.message.contextSnapshot.manifest] : [],
			)[0];
			if (!manifest) throw new Error(`No manifest: ${JSON.stringify(manager.getBranch())}`);
			expect(manifest?.wire).toBeDefined();
			expect("requests" in (manifest?.wire ?? {})).toBe(false);
			const filename = manifest?.wire?.tracePath;
			expect(filename).toBeDefined();
			await session.dispose();
			const rows = (await readFile(filename!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
			expect(rows.map(row => row.kind)).toEqual(["start", "request", "event", "assistant", "complete"]);
			expect(rows[1].value.instructions).toBe("exact prompt");
		} finally {
			await session.dispose();
		}
	});
});

/** An arktype-shaped callable schema from an external arktype copy: a plain
 * function carrying `toJsonSchema`/`assert` that — unlike omptype schemas —
 * HAS `Function.prototype.bind`. */
function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters } as never],
			tokenizer,
		);
		const wireEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never],
			tokenizer,
		);
		expect(arktypeEstimate).toBe(wireEstimate);
	});

	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Regression (PR #9185): applyToolProxy bound every callable property,
		// and an external-arktype Type HAS Function.prototype.bind (unlike
		// omptype), so the bound `parameters` lost its schema surface,
		// toolWireSchema returned the bare function, and the undefined
		// JSON.stringify poisoned token accounting — crashing every read-only
		// subagent at first prompt. The proxied schema must keep counting as
		// its wire JSON Schema, identical to the pre-converted equivalent.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		// The proxied tool must keep counting exactly like the unwrapped tool:
		// old code fed `undefined` into the tokenizer here and crashed.
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		// The crash frame was computeNonMessageBreakdown → estimateToolSchemaTokens
		// inside pre-prompt compaction; exercise that whole path, memo included.
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
	});

	it("skips a parameters value that stringifies to undefined, counting exactly name + description", () => {
		// A plain function is neither an arktype schema nor JSON-serializable:
		// the independent unserializable-schema fallback must skip it while the
		// tool's own strings still contribute their exact token share.
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: "odd tool", parameters: function bareSchema() {} } as never],
			tokenizer,
		);
		expect(estimate).toBe(estimateToolSchemaTokens([{ name: "odd", description: "odd tool" } as never], tokenizer));
	});

	it("skips non-string name/description fragments", () => {
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: undefined, parameters: { type: "object" } } as never],
			tokenizer,
		);
		expect(estimate).toBeGreaterThan(0);
	});
});

/**
 * Contract: the /context panel surfaces estimated snapcompact wire savings —
 * applied swaps show "saves" figures, inactive states say why.
 */
describe("renderContextUsage snapcompact section", () => {
	const themeStub = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	function breakdownWith(snapcompact: ContextBreakdown["snapcompact"]): ContextBreakdown {
		return {
			model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
			contextWindow: 200000,
			categories: [],
			usedTokens: 27929,
			autoCompactBufferTokens: 0,
			freeTokens: 172071,
			snapcompact,
		};
	}

	it("renders savings, skip reasons, and the wire total", () => {
		const output = renderContextUsage(
			breakdownWith({
				visionCapable: true,
				systemPrompt: {
					applied: true,
					scope: "all",
					textTokens: 9768,
					frames: 2,
					imageTokens: 6600,
					savedTokens: 3168,
				},
				toolResults: { total: 3, swapped: 0, textTokens: 0, frames: 0, imageTokens: 0, savedTokens: 0 },
				savedTokens: 3168,
			}),
			themeStub,
		);
		expect(output).toContain("Snapcompact (estimated wire savings)");
		expect(output).toContain("System prompt (all): saves ~3.2K (9.8K text → 2 frames ≈ 6.6K)");
		expect(output).toContain("Tool results: none imaged (3 in history)");
		// 27929 logical − 3168 saved ≈ 25K on the wire.
		expect(output).toContain("Next request: ~25K tokens on the wire");
	});

	it("reports text-only models as inactive", () => {
		const output = renderContextUsage(breakdownWith({ visionCapable: false, savedTokens: 0 }), themeStub);
		expect(output).toContain("Snapcompact: inactive (model has no image input)");
	});

	it("omits the section entirely when no snapcompact setting is on", () => {
		const output = renderContextUsage(breakdownWith(undefined), themeStub);
		expect(output).not.toContain("Snapcompact");
	});
});

/**
 * Contract: the non-message token totals reflect the CURRENT system prompt,
 * tools, and skills — including after they change via reference replacement
 * (the setSystemPrompt/setTools pattern), and stay stable while those inputs
 * hold the same identity. The memo must never serve a stale value for changed
 * inputs.
 */
describe("computeNonMessageTokens / computeNonMessageBreakdown memoization", () => {
	function makeSession(systemPrompt: string[], tools: unknown[] = [], skills: unknown[] = []) {
		return { systemPrompt, agent: { state: { tools } }, skills };
	}

	it("recomputes when the system prompt reference changes and caches otherwise", () => {
		const session = makeSession(["system prompt alpha"]);
		const first = computeNonMessageTokens(session as never, tokenizer);
		// Same inputs (identical refs) → cached, identical value.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(first);
		// Replace the system prompt reference (mirrors setSystemPrompt).
		session.systemPrompt = ["system prompt beta with more tokens than alpha"];
		const afterChange = computeNonMessageTokens(session as never, tokenizer);
		expect(afterChange).toBeGreaterThan(first);
		// Cached on the new inputs.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(afterChange);
	});

	it("recomputes the breakdown when the tools reference changes", () => {
		const session = makeSession(["base"], []);
		const before = computeNonMessageBreakdown(session as never, tokenizer);
		expect(before.toolsTokens).toBe(0);
		// New tools array reference (mirrors setTools).
		session.agent.state.tools = [{ name: "search", description: "search the web", parameters: {} }];
		const after = computeNonMessageBreakdown(session as never, tokenizer);
		expect(after.toolsTokens).toBeGreaterThan(0);
		// Cached on the new tools.
		expect(computeNonMessageBreakdown(session as never, tokenizer).toolsTokens).toBe(after.toolsTokens);
	});

	it("shares one cache entry so tokens and breakdown invalidate together", () => {
		const session = makeSession(["shared prompt"]);
		const tokens = computeNonMessageTokens(session as never, tokenizer);
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		// Changing the system prompt ref must invalidate BOTH fields, not just
		// the one most recently touched.
		session.systemPrompt = ["shared prompt but longer now to shift the count"];
		expect(computeNonMessageTokens(session as never, tokenizer)).not.toBe(tokens);
		expect(computeNonMessageBreakdown(session as never, tokenizer).systemPromptTokens).not.toBe(
			breakdown.systemPromptTokens,
		);
	});
});

/**
 * Contract: the Skills category counts only skills actually rendered into the
 * system prompt (mirroring `buildSystemPrompt`'s filter) — hidden/explicit-only
 * skills, and every skill when the `read` tool is absent, contribute zero. The
 * System-prompt subtraction must not be inflated by unrendered skill metadata
 * and clamped to 0 (issue #6498).
 */
describe("computeNonMessageBreakdown skills filtering", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };
	const hidden = { name: "hidden-skill", description: "X".repeat(4000), filePath: "/s/h.md", hide: true };
	const visible = { name: "vis", description: "small visible skill", filePath: "/s/v.md" };
	// First prompt block as rendered: only the visible skill appears.
	const renderedPrompt = "You are an agent.\nSkills:\n- vis: small visible skill\n";

	function session(tools: unknown[], skills: unknown[]) {
		return { systemPrompt: [renderedPrompt], agent: { state: { tools } }, skills } as never;
	}

	it("excludes hidden skills and does not clamp System prompt to 0", () => {
		const b = computeNonMessageBreakdown(session([readTool], [hidden, visible]), tokenizer);
		// Only the visible skill is counted, not the large hidden one.
		expect(b.skillsTokens).toBe(computeNonMessageBreakdown(session([readTool], [visible]), tokenizer).skillsTokens);
		expect(b.skillsTokens).toBeLessThan(100);
		expect(b.systemPromptTokens).toBeGreaterThan(0);
	});

	it("counts zero Skills tokens when the read tool is unavailable", () => {
		const b = computeNonMessageBreakdown(session([], [hidden, visible]), tokenizer);
		expect(b.skillsTokens).toBe(0);
		expect(b.systemPromptTokens).toBe(computeNonMessageBreakdown(session([], []), tokenizer).systemPromptTokens);
	});
});

/**
 * Contract: a tool, skill, or system-prompt section with a missing
 * (`undefined`) description/text must not crash the token estimate. Extensions
 * can contribute tools whose `description` is absent at runtime (the field is
 * typed `string` but the extension API does not enforce it); before the guard,
 * the `undefined` fragment reached the tokenizer and threw, killing every
 * subagent before its first turn (issue #9331). Each path must instead yield a
 * finite, non-negative estimate.
 */
describe("non-message estimates tolerate a missing description", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };

	it("estimateToolSchemaTokens does not throw on an undefined tool description", () => {
		const tokens = estimateToolSchemaTokens(
			[{ name: "lens_tool", description: undefined, parameters: {} } as never],
			tokenizer,
		);
		expect(Number.isFinite(tokens)).toBe(true);
		expect(tokens).toBeGreaterThanOrEqual(0);
	});

	it("computeNonMessageBreakdown does not throw on an undefined skill description", () => {
		const session = {
			systemPrompt: ["You are an agent."],
			agent: { state: { tools: [readTool] } },
			skills: [{ name: "lens", description: undefined, filePath: "/s/l.md" }],
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.skillsTokens)).toBe(true);
		expect(b.skillsTokens).toBeGreaterThanOrEqual(0);
	});

	it("computeNonMessageBreakdown does not throw on an undefined system-context section", () => {
		const session = {
			systemPrompt: ["primary prompt", undefined, "trailing context"],
			agent: { state: { tools: [readTool] } },
			skills: [],
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.systemContextTokens)).toBe(true);
		expect(b.systemContextTokens).toBeGreaterThanOrEqual(0);
	});
});
