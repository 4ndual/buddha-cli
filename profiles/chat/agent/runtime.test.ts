import { describe, expect, it } from "bun:test";
import type { ProfileRuntimeContext } from "@oh-my-pi/pi-coding-agent/profile-runtime";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { CHAT_SYSTEM_PROMPT } from "./prompt";
import runtime from "./runtime";

describe("chat profile runtime", () => {
	it("replaces the engineering prompt without restricting normal tools", async () => {
		const options: CreateAgentSessionOptions = {
			customSystemPrompt: "old custom prompt",
			appendSystemPrompt: "old appended prompt",
			toolNames: ["read", "bash"],
		};

		await runtime(options, {} as ProfileRuntimeContext);

		expect(typeof options.systemPrompt).toBe("function");
		expect((options.systemPrompt as (defaults: string[]) => string[])(["engineering default"])).toEqual([
			CHAT_SYSTEM_PROMPT,
		]);
		expect(options.customSystemPrompt).toBeUndefined();
		expect(options.appendSystemPrompt).toBeUndefined();
		expect(options.spawns).toBe("task");
		expect(options.toolNames).toEqual(["read", "bash"]);
		expect(options.restrictToolNames).toBeUndefined();
		expect(options.disableExtensionDiscovery).toBeUndefined();
		expect(options.providerContextPolicy).toEqual({ rawMessages: true, skipRequestReminder: true });
		expect(CHAT_SYSTEM_PROMPT).toContain("skill://sota-search");
	});
});
