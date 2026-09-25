import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { estimateContextManifest } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";

const [promptPath, journalPath, outputPath] = process.argv.slice(2);
if (!promptPath || !journalPath || !outputPath) throw new Error("Usage: inspect-context-wire PROMPT_MD JOURNAL_JSONL OUTPUT_JSON");
const markdown = readFileSync(promptPath, "utf8");
const prompt = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
const journal = readFileSync(journalPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
const user = journal.find(entry => entry.type === "message" && entry.message?.role === "user")?.message;
if (!user) throw new Error("No user message in journal");
const expected = journal.find(entry => entry.type === "message" && entry.message?.contextSnapshot?.manifest)?.message?.contextSnapshot?.manifest;
if (!expected) throw new Error("No recorded context manifest");
const temp = mkdtempSync(path.join(tmpdir(), "omp-context-wire-"));
const auth = await AuthStorage.create(path.join(temp, "auth.db"));
const registry = new ModelRegistry(auth, path.join(temp, "models.yml"));
const model = buildModel({
	id: "gpt-6-luna", name: "GPT-6 Luna", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000, maxTokens: 32000,
});
const toolNames = expected.estimated.tools.map((tool: { name: string }) => tool.name);
const { session } = await createAgentSession({
	cwd: temp, agentDir: temp, model, modelRegistry: registry,
	settings: Settings.isolated({ "skills.enabled": false, "mcp.enabled": false }),
	sessionManager: SessionManager.inMemory(temp),
	systemPrompt: [prompt], toolNames, hasUI: true, disableExtensionDiscovery: true,
});
try {
	const tools = session.agent.state.tools;
	const context = { systemPrompt: [prompt], tools, messages: [user] };
	const wire = await buildTransformedCodexRequestBody(model, context, { reasoning: "low", sessionId: "replica-not-live" });
	const estimated = estimateContextManifest({ systemPrompt: [prompt], agent: { state: { tools } }, skills: [] }, [user], session.agent.tokenizer);
	const artifact = {
		status: "replica-from-current-source-not-historical-wire",
		historicalCall: { providerInput: expected.provider.promptTokens, estimated: expected.estimated },
		replica: {
			estimated,
			toolSources: session.getAllToolInfos().filter(tool => toolNames.includes(tool.name)).map(tool => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
			wire,
		},
	};
	writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
	console.log(JSON.stringify({ outputPath, toolNames: tools.map(tool => tool.name), historicalEstimate: expected.estimated.totalTokens, replicaEstimate: estimated.totalTokens, wireKeys: Object.keys(wire) }));
} finally {
	await session.dispose();
	auth.close();
}
