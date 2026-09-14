import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "./config/settings";
import { loadLegacyPiModule } from "./extensibility/plugins/legacy-pi-compat";
import type { CreateAgentSessionOptions } from "./sdk";

export interface ProfileRuntimeContext {
	/** Active named profile. A runtime hook is never loaded for the default profile. */
	profile: string;
	agentDir: string;
	settings: Settings;
	/** Whether the user explicitly selected a model for this launch. */
	explicitModel: boolean;
}

export type ProfileRuntime = (
	options: CreateAgentSessionOptions,
	context: ProfileRuntimeContext,
) => void | Promise<void>;

/**
 * Apply the active named profile's trusted pre-session runtime hook.
 *
 * Ordinary extensions are intentionally too late for this job: by the time an
 * extension factory runs, the system prompt, discovery policy, and restricted
 * tool registry have already been selected. `runtime.ts` is therefore the one
 * profile-owned bootstrap seam that may shape CreateAgentSessionOptions before
 * the session is constructed. Like extensions and hooks, it is executable user
 * configuration and is loaded only from the active profile's agent directory.
 */
export async function applyProfileRuntime(
	options: CreateAgentSessionOptions,
	settings: Settings,
	explicitModel: boolean,
): Promise<void> {
	const profile = getActiveProfile();
	if (!profile) return;
	const agentDir = getAgentDir();
	const runtimePath = path.join(agentDir, "runtime.ts");
	try {
		const stat = await fs.stat(runtimePath);
		if (!stat.isFile()) throw new Error("profile runtime is not a regular file");
		const module = (await loadLegacyPiModule(runtimePath)) as {
			default?: unknown;
		};
		if (typeof module.default !== "function") throw new Error("profile runtime must export a default function");
		await (module.default as ProfileRuntime)(options, { profile, agentDir, settings, explicitModel });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error(
			`Failed to load runtime for OMP profile "${profile}": ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
}
