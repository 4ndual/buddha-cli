import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface Capture {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  examples: unknown[];
  catalog: string;
  tokens: {
    description: number;
    schema: number;
    toolDefinition: number;
    catalog: number;
  };
}

const root = resolve(import.meta.dir, "..");
const directory = join(root, "docs/tool-context-before-after");
const before = JSON.parse(
  await readFile(join(directory, "before.json"), "utf8"),
) as Capture[];
const after = JSON.parse(
  await readFile(join(directory, "after.json"), "utf8"),
) as Capture[];
const source: Record<string, string> = {
  read: "packages/coding-agent/src/tools/read.ts",
  write: "packages/coding-agent/src/tools/write.ts",
  bash: "packages/coding-agent/src/tools/bash.ts",
  ask: "packages/coding-agent/src/tools/ask.ts",
  hub: "packages/coding-agent/src/tools/hub/index.ts",
  eval: "packages/coding-agent/src/tools/eval.ts",
  edit: "packages/coding-agent/src/edit/index.ts",
  task: "packages/coding-agent/src/task/index.ts",
};
const order = ["read", "write", "bash", "task", "ask", "eval", "hub", "edit"];
const beforeByName = new Map(before.map((record) => [record.name, record]));
const afterByName = new Map(after.map((record) => [record.name, record]));
const savings = { description: 0, toolDefinition: 0, catalog: 0 };
const rows: string[] = [];
const signed = (value: number) => (value >= 0 ? `+${value}` : String(value));
const json = (value: unknown) => JSON.stringify(value, null, 2);

async function save(name: string, body: string): Promise<void> {
  const target = join(directory, name);
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== body)
      throw new Error(`Stale audit: ${target}`);
    return;
  }
  await writeFile(target, body);
}

for (const name of order) {
  const old = beforeByName.get(name);
  const now = afterByName.get(name);
  if (!old || !now) throw new Error(`Missing ${name} capture`);
  const descriptionSaved = old.tokens.description - now.tokens.description;
  const wireSaved = old.tokens.toolDefinition - now.tokens.toolDefinition;
  const catalogSaved = old.tokens.catalog - now.tokens.catalog;
  savings.description += descriptionSaved;
  savings.toolDefinition += wireSaved;
  savings.catalog += catalogSaved;
  rows.push(
    `| [${name}](./${name}.md) | ${old.tokens.description} → ${now.tokens.description} (${signed(descriptionSaved)}) | ${old.tokens.toolDefinition} → ${now.tokens.toolDefinition} (${signed(wireSaved)}) | ${old.tokens.catalog} → ${now.tokens.catalog} (${signed(catalogSaved)}) |`,
  );
  const special =
    name === "eval"
      ? "The old eval module hit a pre-existing import cycle in the isolated checkout. Its old ArkType schema was reconstructed from the old source; the description and examples were reused only after their runtime-source text was verified unchanged."
      : name === "task"
        ? "The current task schema includes concurrent uncommitted runtime-tier work. Its token delta is a working-tree snapshot, not an isolated effect of the Zod migration."
        : name === "edit"
          ? "Both captures use the same available native addon for replace-mode description. The TypeScript schema changed; the description source did not."
          : "The descriptors and schemas were read from instantiated tools in isolated source checkouts.";
  const body =
    `# ${name}: model context before and after\n\n` +
    `Old source: commit \`89c4b8dff5\`. New source: current working-tree capture. ` +
    `[Tool implementation](../../${source[name]}). ${special}\n\n` +
    `| Measured surface | Before | After | Tokens saved |\n| --- | ---: | ---: | ---: |\n` +
    `| Description | ${old.tokens.description} | ${now.tokens.description} | ${signed(descriptionSaved)} |\n` +
    `| Provider tool definition (name + description + JSON Schema) | ${old.tokens.toolDefinition} | ${now.tokens.toolDefinition} | ${signed(wireSaved)} |\n` +
    `| Full system-prompt inventory entry | ${old.tokens.catalog} | ${now.tokens.catalog} | ${signed(catalogSaved)} |\n\n` +
    `Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local ` +
    `content count, not provider framing or billable usage. Inventory is rendered one tool at a time, ` +
    `including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.\n\n` +
    `## Before: description\n\n\`\`\`text\n${old.description}\n\`\`\`\n\n` +
    `## After: description\n\n\`\`\`text\n${now.description}\n\`\`\`\n\n` +
    `## Before: input JSON Schema\n\n\`\`\`json\n${json(old.schema)}\n\`\`\`\n\n` +
    `## After: input JSON Schema\n\n\`\`\`json\n${json(now.schema)}\n\`\`\`\n\n` +
    `## Before: complete inventory entry\n\n\`\`\`text\n${old.catalog}\n\`\`\`\n\n` +
    `## After: complete inventory entry\n\n\`\`\`text\n${now.catalog}\n\`\`\`\n\n` +
    `The TypeScript source is **not** sent to the model. OMP sends one of the generated ` +
    `surfaces above, depending on provider and session configuration.\n`;
  await save(`${name}.md`, body);
}

await save(
  "README.md",
  `# OMP tool-context before/after audit\n\n` +
    `[Capture script](../../scripts/capture-tool-context.ts) and [Markdown generator](../../scripts/generate-tool-context-audit.ts). ` +
    `Old checkout: \`89c4b8dff5\`; current capture: working tree after the tool rewrite. ` +
    `The baseline is one explicit configuration: read limit 3000, memory off, async off, ` +
    `both eval backends on, edit replace/full, task flat/no isolation, and the five core tools available. ` +
    `Other profiles and settings produce different context.\n\n` +
    `| Tool | Description tokens | Provider definition tokens | System-inventory tokens |\n` +
    `| --- | ---: | ---: | ---: |\n${rows.join("\n")}\n` +
    `| **All eight if exposed** | **${signed(savings.description)} saved** | **${signed(savings.toolDefinition)} saved** | **${signed(savings.catalog)} saved** |\n\n` +
    `The provider definition count includes the tool name, actual runtime description, and generated JSON Schema; ` +
    `the system inventory is OMP's rendered descriptor with examples. These are **alternative** presentation modes. ` +
    `Neither count includes provider framing, hidden overhead, repeated-turn caching, or billable-token behavior. ` +
    `The model does not receive the self-explanatory TypeScript source. ` +
    `Read each tool's caveat before attributing its delta to this migration—especially task (concurrent uncommitted runtime-tier edits) ` +
    `and eval (old module import cycle). Legacy Markdown files remain as source/history and are not live descriptions for the five shortened tools.\n`,
);
console.log(rows.join("\n"));
