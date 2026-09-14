import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { schemaType } from "../src";
import { TASK_LIFECYCLE_SERVICE, type TaskLifecycleService } from "../src/task/lifecycle-service";
import { getTaskSchema } from "../src/task/types";
import buddhaTools from "../../../profiles/buddha-v1/agent/extensions/buddha-tools";

test("buddha tools extension owns lifecycle policy and leaves it profile-scoped", () => {
	const services = new Map<string, unknown>();
	const tools: string[] = [];
	buddhaTools({
		arktype: schemaType,
		registerTool: (tool: { name: string }) => {
			tools.push(tool.name);
		},
		registerExtensionService: (name: string, service: unknown) => {
			services.set(name, service);
		},
	} as never);

	expect(tools).toEqual(["complete", "parent"]);
	const lifecycle = services.get(TASK_LIFECYCLE_SERVICE) as TaskLifecycleService;
	expect(lifecycle).toBeDefined();
	expect(lifecycle.validate?.({ task: "do work", rt: "R2" }, "The task")).toContain("# Acceptance");
	expect(lifecycle.validate?.({ task: "do work\n# Acceptance\npasses" }, "The task")).toContain("rt");
	expect(lifecycle.validate?.({ task: "do work\n# Acceptance\npasses", rt: "R2" }, "The task")).toBeUndefined();
	const profileSchema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, runtimeTierEnabled: true });
	expect(profileSchema({ task: "do work" }) instanceof type.errors).toBe(true);
	expect(profileSchema({ task: "do work", rt: "R2" }) instanceof type.errors).toBe(false);
	expect(
		lifecycle.formatTelemetry?.({
			index: 0,
			id: "worker",
			agent: "task",
			agentSource: "bundled",
			task: "work",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 12,
			tokens: 3,
			requests: 1,
			telemetry: {
				startedAtMs: 0,
				settledAtMs: 12,
				durationMs: 12,
				requests: 1,
				tools: [{ name: "read" }],
				explanation: "1 request; 1 tool call.",
			},
		}),
	).toContain("- tools: read");
});
