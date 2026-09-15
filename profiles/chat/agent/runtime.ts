import type { ProfileRuntime } from "@oh-my-pi/pi-coding-agent/profile-runtime";
import { CHAT_SYSTEM_PROMPT } from "./prompt";

const runtime: ProfileRuntime = options => {
	// Function form discards all rendered default prompt blocks, including the
	// engineering prompt, project rules, and automatic skills catalogue.
	options.systemPrompt = () => [CHAT_SYSTEM_PROMPT];
	options.customSystemPrompt = undefined;
	options.appendSystemPrompt = undefined;

	// Keep the task tool available for exceptional cases, but limit delegation
	// to the generic task agent. Frequency is governed by the prompt above.
	options.spawns = "task";

	// Avoid provider-added request reminders reintroducing workflow framing.
	// Normal OMP tools and global skill resources remain available.
	options.providerContextPolicy = {
		rawMessages: true,
		skipRequestReminder: true,
	};
};

export default runtime;
