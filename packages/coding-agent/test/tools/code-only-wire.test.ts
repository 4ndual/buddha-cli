import { expect, test } from "bun:test";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { EditTool } from "../../src/edit";
import { Settings } from "../../src/config/settings";
import { createSettingsAwareStreamFn } from "../../src/session/settings-stream-fn";
import { TaskTool } from "../../src/task";
import type { ToolSession } from "../../src/tools";
import { AskTool } from "../../src/tools/ask";
import { BashTool } from "../../src/tools/bash";
import { EvalTool } from "../../src/tools/eval";
import { HubTool } from "../../src/tools/hub";
import { ReadTool } from "../../src/tools/read";
import { WriteTool } from "../../src/tools/write";

function requestText(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(Bun.zstdDecompressSync(body));
	throw new Error("Expected a serialized Codex request body");
}

test("the Codex request sends code-derived schemas without prose for the eight core tools", async () => {
	const settings = Settings.isolated();
	const session = {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	const tools = [
		new ReadTool(session),
		new EditTool(session, "replace"),
		new WriteTool(session),
		new BashTool(session),
		new AskTool(session),
		new EvalTool(session),
		await TaskTool.create(session),
		new HubTool(session),
	];
	const model = buildModel({
		id: "gpt-5.3-codex-spark",
		name: "Codex test model",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "http://127.0.0.1:2455/backend-api/codex",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	}) as Model;
	const context: Context = {
		systemPrompt: ["Tool catalog test"],
		messages: [{ role: "user", content: "Use a tool", timestamp: Date.now() }],
		tools: [
			...tools,
			{
				name: "custom_probe",
				description: "Keep this custom tool description",
				parameters: { type: "object", properties: { value: { type: "string" } } },
			},
		],
	};
	let request: { tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> } = {};
	const fetch: FetchImpl = async (_input, init) => {
		request = JSON.parse(requestText(init?.body)) as typeof request;
		const sse = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n");
		return new Response(`${sse}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const stream = await createSettingsAwareStreamFn(settings, streamSimple)(model, context, {
		apiKey: "test-token",
		fetch,
	});
	const result = await stream.result();
	expect(result.errorMessage).toBeUndefined();
	expect(result.stopReason).toBe("stop");
	expect(request.tools?.map(tool => tool.name)).toEqual([...tools.map(tool => tool.name), "custom_probe"]);
	for (const tool of request.tools ?? []) {
		if (tool.name === "custom_probe") {
			expect(tool.description).toBe("Keep this custom tool description");
			continue;
		}
		expect(tool.description).toBe("");
		expect(tool.parameters?.type).toBe("object");
		expect(tool.parameters?.properties).toBeDefined();
		expect(JSON.stringify(tool.parameters)).not.toMatch(/"(?:description|title|\$comment)":"/);
	}
	expect(tools.every(tool => tool.description.length > 0)).toBe(true);
});
