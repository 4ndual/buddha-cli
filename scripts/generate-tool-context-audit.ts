import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Tokenizer } from "../packages/agent/src/tokenizer";
import { prompt } from "@oh-my-pi/pi-utils";
import { ReadTool } from "../packages/coding-agent/src/tools/read";
import { WriteTool } from "../packages/coding-agent/src/tools/write";
import { BashTool } from "../packages/coding-agent/src/tools/bash";
import { AskTool } from "../packages/coding-agent/src/tools/ask";
import { HubTool } from "../packages/coding-agent/src/tools/hub";
import { resolveEditToolDescription } from "../packages/coding-agent/src/edit";

const root = resolve(import.meta.dir, "..");
const outputDir = join(root, "docs/tool-context-before-after");
const tokenCounter = new Tokenizer();
const toolRoot = "packages/coding-agent/src";
const settingsValues: Record<string, unknown> = {
	"read.defaultLimit": 3000,
	"images.autoResize": false,
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bash.autoBackground.thresholdMs": 30000,
	"glob.enabled": true,
	"grep.enabled": true,
	"astGrep.enabled": false,
	"astEdit.enabled": false,
	"launch.enabled": true,
	"eval.enabled": true,
	"eval.py": true,
	"eval.js": true,
	"lsp.formatOnWrite": false,
	"lsp.diagnosticsOnWrite": false,
	"memory.backend": "off",
};
const session = {
	cwd: root,
	enableLsp: false,
	hasUI: true,
	settings: { get: (key: string) => settingsValues[key] ?? false, getShellConfig: () => ({ env: {} }) },
	isToolActive: (name: string) => ["read", "glob", "grep", "eval", "hub"].includes(name),
} as never;

async function headFile(relative: string): Promise<string> {
	const proc = Bun.spawnSync(["git", "show", `HEAD:${relative}`], { cwd: root });
	if (proc.exitCode !== 0) throw new Error(`Missing HEAD source: ${relative}`);
	return proc.stdout.toString().trim();
}

const specs = [
	{
		name: "read", before: `${toolRoot}/prompts/tools/read.md`, source: `${toolRoot}/tools/read.ts`,
		schema: "readSchema", after: new ReadTool(session).description,
		context: { IS_HL_MODE: false },
	},
	{
		name: "write", before: `${toolRoot}/prompts/tools/write.md`, source: `${toolRoot}/tools/write.ts`,
		schema: "writeSchema", after: new WriteTool(session).description,
		context: {},
	},
	{
		name: "bash", before: `${toolRoot}/prompts/tools/bash.md`, source: `${toolRoot}/tools/bash.ts`,
		schema: "bashSchemaBase", after: new BashTool(session).description,
		context: { hasEval: true, hasShellBuiltins: true, asyncEnabled: false, autoBackgroundEnabled: false, hasGrep: true, hasRead: true, hasGlob: true, hasLaunch: true, isWindows: false },
	},
	{
		name: "ask", before: `${toolRoot}/prompts/tools/ask.md`, source: `${toolRoot}/tools/ask.ts`,
		schema: "askSchema", after: new AskTool(session).description,
		context: {},
	},
	{
		name: "hub", before: `${toolRoot}/prompts/tools/hub.md`, source: `${toolRoot}/tools/hub/index.ts`,
		schema: "hubSchema", after: new HubTool(session).description,
		context: {},
	},
	{
		name: "eval", before: `${toolRoot}/prompts/tools/eval.md`, source: `${toolRoot}/tools/eval.ts`,
		schema: "evalSchema", after: null,
		context: { py: true, js: true, evalTools: true, eagerDelegation: true, autoBackgroundEnabled: false, spawns: true, spawnDefaultAgent: "task", spawnAllowedAgentsText: "", preludeDocumentation: "" },
	},
	{
		name: "task", before: `${toolRoot}/prompts/tools/task.md`, source: `${toolRoot}/task/index.ts`,
		schema: "getTaskSchema", after: null,
		context: { asyncEnabled: false, batchEnabled: false, hasBlockingAgents: false, scoutAvailable: false, ircEnabled: false, evalToolsEnabled: false, effortEnabled: false, isolationEnabled: false, applyIsolatedChanges: false, spawningDisabled: true, defaultAgent: "task", allowedAgentsText: "", agents: [] },
	},
] as const;

await mkdir(outputDir, { recursive: true });
async function save(name: string, content: string): Promise<void> {
	const target = join(outputDir, name);
	if (process.argv.includes("--check")) {
		const existing = await readFile(target, "utf8");
		if (existing !== content) throw new Error(`Stale context audit: ${target}`);
		return;
	}
	await writeFile(target, content);
}
const rows: string[] = [];
for (const spec of specs) {
	const legacyTemplate = await headFile(spec.before);
	const before = prompt.render(legacyTemplate, spec.context);
	const after = spec.after ?? before;
	const oldCount = tokenCounter.countTokens(before, "strict");
	const newCount = tokenCounter.countTokens(after, "strict");
	const delta = oldCount - newCount;
	rows.push(`| [${spec.name}](./${spec.name}.md) | ${oldCount} | ${newCount} | ${delta > 0 ? `+${delta}` : delta} |`);
	const output = `# ${spec.name}: before and after model-facing description\n\n` +
		`Baseline: source checkout at HEAD for the previous template, current working tree for the new tool. ` +
		`Conditional settings are fixed by [the generator](../../scripts/generate-tool-context-audit.ts); other profiles can differ. ` +
		`OMP may send this descriptor in the provider tool schema or move it into the system prompt. ` +
		`Neither the TypeScript source nor this audit file is itself sent to the model.\n\n` +
		`Previous description: **${oldCount}** tokens. Current description: **${newCount}** tokens. ` +
		`Description-only saving: **${delta}** tokens per exposed tool definition. ` +
		`Counted with OMP's Tokenizer strict mode (o200k fallback); provider framing, examples, schema JSON, caching, and billing are excluded.\n\n` +
		`## Before — rendered from ${spec.before}\n\n\`\`\`text\n${before}\n\`\`\`\n\n` +
		`## After — current runtime description\n\n\`\`\`text\n${after}\n\`\`\`\n\n` +
		`## Code contract\n\nThe live input contract is \`${spec.schema}\` in [${spec.source}](../../${spec.source}); ` +
		`Zod is the runtime parser and JSON Schema source. The schema is separately sent as a tool definition when this tool is active. ` +
		`${spec.name === "task" || spec.name === "eval" ? "This tool retains dynamic instructions; the Zod migration did not shorten this description. " : ""}` +
		`The result contract is parsed at the tool boundary. This document is a measurement snapshot, not a replacement for executable code.\n`;
	await save(`${spec.name}.md`, output);
}

const editDescription = resolveEditToolDescription("replace", undefined);
const editCount = tokenCounter.countTokens(editDescription, "strict");
rows.push(`| [edit](./edit.md) | ${editCount} | ${editCount} | 0 |`);
await save("edit.md", `# edit: before and after model-facing description\n\n` +
	`Baseline: replace mode, full prompt variant. The descriptor comes from the native addon through ` +
	`[resolveEditToolDescription](../../${toolRoot}/edit/index.ts); this migration changed the input/output schema path, not the descriptor. ` +
	`Other edit modes and the compact variant have different descriptions.\n\n` +
	`Previous description: **${editCount}** tokens. Current description: **${editCount}** tokens. Description-only saving: **0** tokens. ` +
	`Counted with OMP's Tokenizer strict mode (o200k fallback); schema, examples and provider framing excluded.\n\n` +
	`## Before\n\n\`\`\`text\n${editDescription}\n\`\`\`\n\n` +
	`## After\n\n\`\`\`text\n${editDescription}\n\`\`\`\n\n` +
	`## Code contract\n\nMode-specific schemas are in [edit/schemas.ts](../../${toolRoot}/edit/schemas.ts), ` +
	`converted to JSON Schema with \`zodWire\` and parsed at the tool boundary.\n`);

await save("README.md", `# OMP tool-context migration audit\n\n` +
	`Generated by [generate-tool-context-audit.ts](../../scripts/generate-tool-context-audit.ts). ` +
	`These are per-tool descriptions under the generator's explicit baseline, not a claim that all eight tools appear in every request. ` +
	`Profiles, enabled tools, edit mode, code mode, async mode, prompt-variant policy, and provider transport change the actual context. ` +
	`The old prompt files remain in the tree as source/history; the live short descriptors come from TypeScript.\n\n` +
	`| Tool | Before | After | Saved |\n| --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\n` +
	`Counts are description-only using OMP's strict tokenizer with its o200k fallback. ` +
	`They do **not** establish total base-context or billable-token savings: JSON Schema, tool examples, provider framing and caching are separate. ` +
	`The model receives generated schema/description, not the self-explanatory TypeScript itself. ` +
	`Task, eval and edit intentionally retain substantial instructions where schema alone cannot encode behavior.\n`);
console.log(rows.join("\n"));
