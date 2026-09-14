#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PROFILE_NAMES = new Set(["stock", "buddha-v1"]);
const LEGACY_FILES = ["AGENTS.md", "PERSONALITY.md", "SYSTEM.md", "RULES.md", "config.yml", "mcp.json", "models.yml"];
const LEGACY_DIRECTORIES = ["agents", "skills", "commands", "hooks"];
const LEGACY_EXTENSIONS = [
	"atomic-reviewer-clean-system-prompt.ts",
	"default-output-policy.ts",
	"gate-reviewer-clean-system-prompt.ts",
	"herdr-omp-agent-state.ts",
	"peek.ts",
	"random-role.ts",
	"task-completion-gate.ts",
	"timer.ts",
	"tiny-clean-system-prompt.ts",
];

function option(name: string): string | undefined {
	const inline = process.argv.find(argument => argument.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
	try {
		await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

const profile = option("--profile");
if (!profile || !PROFILE_NAMES.has(profile)) {
	throw new Error("Usage: install-profile.ts --profile stock|buddha-v1 [--root <omp-root>] [--legacy-agent-dir <dir>] [--bridge-dir <dir>]");
}

const root = path.resolve(option("--root") ?? path.join(os.homedir(), ".omp"));
const template = path.resolve(import.meta.dir, "..", "profiles", profile, "agent");
const profileRoot = path.join(root, "profiles", profile);
const destination = path.join(profileRoot, "agent");
const temporary = path.join(profileRoot, `.agent.install-${process.pid}`);

try {
	const existing = await fs.readdir(destination);
	if (existing.length >= 0) throw new Error(`Profile already exists: ${destination}`);
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 });
await fs.cp(template, temporary, { recursive: true, force: false, errorOnExist: true });

if (profile === "buddha-v1") {
	const legacy = option("--legacy-agent-dir");
	if (legacy) {
		for (const name of LEGACY_FILES) await copyIfPresent(path.join(legacy, name), path.join(temporary, name));
		for (const name of LEGACY_DIRECTORIES) await copyIfPresent(path.join(legacy, name), path.join(temporary, name));
		for (const name of LEGACY_EXTENSIONS) {
			await copyIfPresent(path.join(legacy, "extensions", name), path.join(temporary, "extensions", name));
		}
	}
	const bridge = option("--bridge-dir");
	if (bridge) await copyIfPresent(path.join(bridge, "extension"), path.join(temporary, "extensions", "omp-live"));
}

await fs.rename(temporary, destination);
process.stdout.write(`${profile}\t${destination}\n`);
