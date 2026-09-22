import { describe, expect, it } from "bun:test";
import { toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import * as z from "zod/v4";
import { EditTool } from "../../src/edit";
import { TaskTool } from "../../src/task";
import {
	applyPatchSchema,
	hashlineEditParamsSchema,
	patchEditSchema,
	replaceEditSchema,
	sloppyEditSchema,
} from "../../src/edit/schemas";
import { getTaskSchema } from "../../src/task/types";
import { AskTool, askSchema } from "../../src/tools/ask";
import { BashTool, bashSchemaBase, bashSchemaWithAsync } from "../../src/tools/bash";
import { EvalTool, evalSchema } from "../../src/tools/eval";
import { HubTool, hubSchema } from "../../src/tools/hub";
import { ReadTool, readSchema } from "../../src/tools/read";
import { WriteTool, writeSchema } from "../../src/tools/write";
import { ToolResultOutput, zodWire } from "../../src/tools/zod-wire";

const contracts = [
	["read", readSchema, { path: "src/main.ts" }],
	["write", writeSchema, { path: "out.txt", content: "" }],
	["bash", bashSchemaBase, { command: "pwd" }],
	["ask", askSchema, { questions: [{ id: "q", question: "Choose?", options: [{ label: "A" }] }] }],
	["eval", evalSchema, { language: "js", code: "1 + 1" }],
	["hub", hubSchema, { op: "list" }],
	["edit.replace", replaceEditSchema, { path: "a.txt", old_string: "a", new_string: "b" }],
	["edit.patch", patchEditSchema, { path: "a.txt", edits: [{ op: "update", diff: "@@\n-a\n+b" }] }],
	["edit.apply_patch", applyPatchSchema, { input: "*** Begin Patch\n*** End Patch" }],
	["edit.hashline", hashlineEditParamsSchema, { input: "a.txt#x => b" }],
	["edit.sloppy", sloppyEditSchema, { input: "a.txt: a => b" }],
] as const;

describe("OMP Zod tool contracts", () => {
	for (const [name, schema, valid] of contracts) {
		it(`${name} parses input and derives a provider wire schema`, () => {
			expect(schema.safeParse(valid).success).toBe(true);
			expect(schema.safeParse({}).success).toBe(false);
			const tool = { name, description: name, parameters: zodWire(schema) };
			const wire = toolWireSchema(tool);
			expect(wire.type).toBe("object");
			expect(wire.properties).toBeDefined();
			expect(z.toJSONSchema(schema).type).toBe("object");
			const normalized = validateToolArguments(tool, {
				type: "toolCall",
				id: `${name}-test`,
				name,
				arguments: valid,
			});
			expect(normalized).toMatchObject(valid);
		});
	}

	it("retains the optional async bash capability only when enabled", () => {
		expect("async" in (z.toJSONSchema(bashSchemaBase).properties ?? {})).toBe(false);
		expect("async" in (z.toJSONSchema(bashSchemaWithAsync).properties ?? {})).toBe(true);
	});

	it("rejects reserved ask labels at the Zod boundary", () => {
		expect(
			askSchema.safeParse({ questions: [{ id: "q", question: "?", options: [{ label: "Chat about this" }] }] })
				.success,
		).toBe(false);
	});

	it("preserves flat and batch task shapes with their feature switches", () => {
		const flat = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			effortEnabled: false,
			evalToolsEnabled: false,
			defaultAgent: "scout",
		});
		const batch = getTaskSchema({
			isolationEnabled: true,
			batchEnabled: true,
			effortEnabled: true,
			evalToolsEnabled: true,
		});
		expect(flat.parse({ task: "# Acceptance\nDone", rt: "R1" })).toEqual({
			agent: "scout",
			task: "# Acceptance\nDone",
			rt: "R1",
		});
		expect(flat.safeParse({ context: "x", tasks: [] }).success).toBe(false);
		expect(
			batch.parse({ context: "x", tasks: [{ task: "# Acceptance\nDone", rt: "R2", effort: "lo", isolated: true }] }),
		).toMatchObject({ tasks: [{ agent: "task", effort: "lo", isolated: true }] });
		const flatWire = z.toJSONSchema(flat);
		const batchWire = z.toJSONSchema(batch);
		expect(flatWire.properties).not.toHaveProperty("tools");
		expect(flatWire.properties).not.toHaveProperty("isolated");
		expect(batchWire.properties).toHaveProperty("tasks");
		const taskTool = { name: "task", description: "task", parameters: zodWire(flat) };
		const args = validateToolArguments(taskTool, {
			type: "toolCall",
			id: "task-default",
			name: "task",
			arguments: { task: "# Acceptance\nDone", rt: "R1" },
		});
		expect(flat.parse(args)).toMatchObject({ agent: "scout" });
	});

	it("parses tool results without echoing or changing them", () => {
		const result = { content: [{ type: "text" as const, text: "done" }], details: { id: "job-1" } };
		expect(ToolResultOutput.parse(result)).toEqual(result);
		expect(ToolResultOutput.safeParse({ content: [{ type: "text" }] }).success).toBe(false);
		expect(z.toJSONSchema(ToolResultOutput).type).toBe("object");
	});

	it("keeps simple tool descriptions compact while naming their non-obvious modes", () => {
		const session = {
			cwd: "/tmp",
			hasUI: true,
			enableLsp: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
		const descriptions = [
			new ReadTool(session).description,
			new WriteTool(session).description,
			new BashTool(session).description,
			new AskTool(session).description,
			new HubTool(session).description,
		];
		for (const description of descriptions) expect(description.length).toBeLessThan(1500);
		expect(descriptions[1]).toContain("xd://");
		expect(descriptions[2]).toContain("hub start");
		expect(descriptions[3]).toContain("Other");
		expect(descriptions[4]).toContain("ready");
	});

	it("direct built-in calls surface ZodError before execution", async () => {
		const session = {
			cwd: "/tmp",
			hasUI: false,
			enableLsp: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
		const tools = [
			new ReadTool(session),
			new WriteTool(session),
			new BashTool(session),
			new AskTool(session),
			new EvalTool(session),
			new HubTool(session),
			new EditTool(session, "replace"),
		];
		for (const tool of tools) {
			expect(toolWireSchema(tool).type).toBe("object");
			await expect(tool.execute("invalid", {} as never)).rejects.toBeInstanceOf(z.ZodError);
		}
		const task = await TaskTool.create(session);
		expect(toolWireSchema(task).type).toBe("object");
	});
});
