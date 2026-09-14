/**
 * Buddha-mode session wiring.
 *
 * Buddha's model context must be exactly: the 5-line {@link BUDDHA_SYSTEM_PROMPT},
 * the user conversation, and one `siddhi` tool. That is enforced structurally by
 * the session options built here (prompt replacement + a restricted single-tool
 * registry) and re-checked fail-closed on every provider request in `sdk.ts`.
 */
import type { ModelRoleLookup } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { formatModelRoleAlias } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { BUDDHA_SYSTEM_PROMPT } from "./prompts";
import { createSiddhiTool } from "./siddhi-tool";

/**
 * Mutate root-session options into Buddha shape. MUST run after every other
 * option is populated: it deliberately overwrites prompt and tool selection so
 * nothing discovered, configured, or CLI-supplied can widen Buddha's context.
 *
 * `explicitModel` is the caller's `--model` flag presence, NOT the resolved
 * session model: an explicit selector always outranks the `buddha` role, and by
 * this point the options carry a model regardless of where it came from.
 */
export function applyBuddhaSessionOptions(
	options: CreateAgentSessionOptions,
	ctx: { settings: ModelRoleLookup; explicitModel: boolean },
): void {
	// The FUNCTION form discards the fully rendered default prompt wholesale
	// (sdk.ts `buildSystemPrompt`); `customSystemPrompt` would not, because the
	// bundled template still appends project prompt / skills / rules blocks.
	options.systemPrompt = () => [BUDDHA_SYSTEM_PROMPT];
	// Prompt inputs resolved earlier (SYSTEM.md, --system-prompt, --append-system-prompt)
	// feed only the default prompt, which is now discarded. Clear them so no later
	// consumer can re-attach them to Buddha's context.
	options.customSystemPrompt = undefined;
	options.appendSystemPrompt = undefined;
	// Exactly one tool, and it is an SDK custom tool: a restricted session drops
	// built-ins, extensions, MCP, memory, skills and IRC, so `siddhi` needs the
	// explicit custom-tool exemption to survive the restriction.
	options.toolNames = ["siddhi"];
	options.restrictToolNames = true;
	options.allowRestrictedCustomTools = true;
	options.allowRestrictedExtensions = true;
	options.disableExtensionDiscovery = true;
	options.customTools = [createSiddhiTool()];
	// Root Buddha runs the `buddha` role, but only when it is actually
	// configured: an unset role does NOT mean "no opinion" downstream — an
	// `@buddha` selector would fall through `ROLE_PRIORITY_ALIAS` to the `smol`
	// chain (model-resolver.ts), silently swapping in a fast model nobody asked
	// for. Leaving the options untouched keeps an unconfigured box on whatever
	// model it resolved before Buddha mode existed.
	if (!ctx.explicitModel && ctx.settings.getModelRole("buddha") !== undefined) {
		// The alias, not a resolved model: role expansion, thinking suffixes and
		// retry-fallback chains all hang off the pattern path in `sdk.ts`.
		options.model = undefined;
		options.modelPattern = formatModelRoleAlias("buddha");
	}
	// `requireYieldTool` is intentionally NOT set: it would force a second tool
	// (`yield`) into Buddha's active set.
	options.providerContextPolicy = {
		rawMessages: true,
		skipRequestReminder: true,
		invariant: { toolNames: ["siddhi"], systemPromptBlocks: 1 },
	};
}
