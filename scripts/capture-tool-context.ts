import { readFile, writeFile } from "node:fs/promises";
import { Tokenizer } from "../packages/agent/src/tokenizer";
import { renderToolInventory } from "../packages/ai/src/dialect";
import { toolWireSchema } from "../packages/ai/src/utils/schema/wire";
import { prompt } from "@oh-my-pi/pi-utils";
import { ReadTool } from "../packages/coding-agent/src/tools/read";
import { WriteTool } from "../packages/coding-agent/src/tools/write";
import { BashTool } from "../packages/coding-agent/src/tools/bash";
import { AskTool } from "../packages/coding-agent/src/tools/ask";
import { HubTool } from "../packages/coding-agent/src/tools/hub";
import taskTemplate from "../packages/coding-agent/src/prompts/tools/task.md" with { type: "text" };

const destination = process.argv[2];
if (!destination) throw new Error("Pass an output JSON path");
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
  "eval.py": true,
  "eval.js": true,
  "lsp.formatOnWrite": false,
  "lsp.diagnosticsOnWrite": false,
  "lsp.diagnosticsOnEdit": false,
  "lsp.diagnosticsDeduplicate": false,
  "edit.fuzzyMatch": false,
  "edit.fuzzyThreshold": 0,
  "memory.backend": "off",
};
const session = {
  cwd: process.cwd(),
  enableLsp: false,
  hasUI: true,
  settings: {
    get: (key: string) => settingsValues[key] ?? false,
    getShellConfig: () => ({ env: {} }),
  },
  isToolActive: (name: string) =>
    ["read", "glob", "grep", "eval", "hub"].includes(name),
  getActiveModel: () => undefined,
} as never;
const tools = [
  new ReadTool(session),
  new WriteTool(session),
  new BashTool(session),
  new AskTool(session),
  new HubTool(session),
];
if (process.env.CAPTURE_OLD === "1") {
  const [
    { getTaskSchema },
    { replaceEditSchema },
    { editDescription },
    { type },
  ] = await Promise.all([
    import("../packages/coding-agent/src/task/types"),
    import("../packages/coding-agent/src/edit/schemas"),
    import("@oh-my-pi/pi-natives"),
    import("@oh-my-pi/omptype"),
  ]);
  const after = JSON.parse(
    await readFile("/capture/after.json", "utf8"),
  ) as Array<{ name: string; description: string }>;
  const evalDescription = after.find(
    (tool) => tool.name === "eval",
  )?.description;
  if (!evalDescription)
    throw new Error("Missing unchanged eval description in current capture");
  const evalSchema = type({
    language: type("'py' | 'js'").describe(
      'runtime: "py" for the IPython kernel, "js" for the persistent JS VM',
    ),
    "title?": type("string").describe(
      'short label shown in transcript (e.g. "imports", "load config")',
    ),
    "timeout?": type("number").describe(
      "timeout for this eval call in seconds; 0 disables the cell timeout",
    ),
    "reset?": type("boolean").describe(
      "wipe this language's kernel before running. Other languages are untouched.",
    ),
    code: type("string").describe(
      "code to run in this eval call, verbatim. Use top-level await freely.",
    ),
  });
  tools.push(
    {
      name: "eval",
      description: evalDescription,
      parameters: evalSchema,
    } as never,
    {
      name: "edit",
      description: prompt.render(editDescription("replace")),
      parameters: replaceEditSchema,
    } as never,
  );
  const taskDescription = prompt.render(taskTemplate, {
    asyncEnabled: false,
    batchEnabled: false,
    hasBlockingAgents: false,
    scoutAvailable: false,
    ircEnabled: false,
    evalToolsEnabled: false,
    effortEnabled: false,
    isolationEnabled: false,
    applyIsolatedChanges: false,
    spawningDisabled: true,
    defaultAgent: "task",
    allowedAgentsText: "",
    agents: [],
  });
  tools.push({
    name: "task",
    description: taskDescription,
    parameters: getTaskSchema({
      isolationEnabled: false,
      batchEnabled: false,
      effortEnabled: false,
      evalToolsEnabled: false,
      defaultAgent: "task",
    }),
  } as never);
} else if (process.env.CAPTURE_CORE_ONLY !== "1") {
  const [{ EvalTool }, { EditTool }, { getTaskSchema }, { zodWire }] =
    await Promise.all([
      import("../packages/coding-agent/src/tools/eval"),
      import("../packages/coding-agent/src/edit"),
      import("../packages/coding-agent/src/task/types"),
      import("../packages/coding-agent/src/tools/zod-wire"),
    ]);
  tools.push(
    new EvalTool(null) as never,
    new EditTool(session, "replace") as never,
  );
  const taskDescription = prompt.render(taskTemplate, {
    asyncEnabled: false,
    batchEnabled: false,
    hasBlockingAgents: false,
    scoutAvailable: false,
    ircEnabled: false,
    evalToolsEnabled: false,
    effortEnabled: false,
    isolationEnabled: false,
    applyIsolatedChanges: false,
    spawningDisabled: true,
    defaultAgent: "task",
    allowedAgentsText: "",
    agents: [],
  });
  tools.push({
    name: "task",
    description: taskDescription,
    parameters: zodWire(
      getTaskSchema({
        isolationEnabled: false,
        batchEnabled: false,
        effortEnabled: false,
        evalToolsEnabled: false,
        defaultAgent: "task",
      }),
    ),
  } as never);
}

const tokenizer = new Tokenizer();
const capture = tools.map((tool) => {
  const schema = toolWireSchema(tool as never);
  const schemaJson = JSON.stringify(schema);
  const description = tool.description;
  const examples = "examples" in tool ? tool.examples : undefined;
  const catalog = renderToolInventory([
    { name: tool.name, description, parameters: tool.parameters, examples },
  ]);
  return {
    name: tool.name,
    description,
    schema,
    examples: examples ?? [],
    catalog,
    tokens: {
      description: tokenizer.countTokens(description, "strict"),
      schema: tokenizer.countTokens(schemaJson, "strict"),
      toolDefinition: tokenizer.countTokens(
        [tool.name, description, schemaJson],
        "strict",
      ),
      catalog: tokenizer.countTokens(catalog, "strict"),
    },
  };
});
const serialized = `${JSON.stringify(capture, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== serialized)
    throw new Error(`Stale capture: ${destination}`);
} else {
  await writeFile(destination, serialized);
}
console.log(
  capture
    .map(
      ({ name, tokens }) =>
        `${name}: ${tokens.toolDefinition} wire, ${tokens.catalog} catalog`,
    )
    .join("\n"),
);
