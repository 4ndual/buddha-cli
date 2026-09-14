import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProfileRuntime } from "@oh-my-pi/pi-coding-agent/profile-runtime";
import { applyBuddhaSessionOptions } from "./runtime/session-options";

const runtime: ProfileRuntime = async (options, context) => {
	applyBuddhaSessionOptions(options, context);

	// Buddha's root context remains restricted, but these explicitly named
	// profile services still load for terminal synchronization and the Hub.
	const candidates = [
		path.join(context.agentDir, "extensions", "buddha-runtime", "index.ts"),
		path.join(context.agentDir, "extensions", "buddha-tools", "index.ts"),
		path.join(context.agentDir, "extensions", "omp-live", "live-session.ts"),
	];
	const profileExtensions: string[] = [];
	for (const candidate of candidates) {
		if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) profileExtensions.push(candidate);
	}
	options.additionalExtensionPaths = [...(options.additionalExtensionPaths ?? []), ...profileExtensions];
};

export default runtime;
