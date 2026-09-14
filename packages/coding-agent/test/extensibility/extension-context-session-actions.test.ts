import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

describe("ExtensionContext session actions", () => {
	it("forwards session and approval operations to core handlers", async () => {
		const calls: string[] = [];
		const result = { cancelled: false };
		const actions = {} as unknown as ExtensionActions;
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			setToolApproval: (toolName, policy) => calls.push(`approval:${toolName}:${policy}`),
			getContextUsage: () => undefined,
			compact: async () => {},
			newSession: async options => {
				calls.push(`new:${options?.parentSession ?? ""}`);
				return result;
			},
			branch: async entryId => {
				calls.push(`branch:${entryId}`);
				return result;
			},
			navigateTree: async (targetId, options) => {
				calls.push(`tree:${targetId}:${options?.summarize === true}`);
				return result;
			},
			getSystemPrompt: () => [],
		};
		const runner = new ExtensionRunner(
			[],
			{} as unknown as ExtensionRuntime,
			"/tmp",
			{ getCwd: () => "/tmp" } as never,
			{} as never,
		);
		runner.initialize(actions, contextActions);
		const ctx = runner.createContext();

		expect(await ctx.newSession({ parentSession: "parent" })).toBe(result);
		expect(await ctx.branch("entry")).toBe(result);
		expect(await ctx.navigateTree("target", { summarize: true })).toBe(result);
		ctx.setToolApproval?.("bash", "allow");
		expect(calls).toEqual(["new:parent", "branch:entry", "tree:target:true", "approval:bash:allow"]);
	});
});
