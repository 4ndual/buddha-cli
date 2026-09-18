#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PROFILE_NAMES = new Set(["stock", "buddha-v1", "chat"]);
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

const USAGE =
	"Usage: install-profile.ts --profile stock|buddha-v1|chat [--update|--rollback] [--root <omp-root>] [--legacy-agent-dir <dir>] [--bridge-dir <dir>] [--backup <dir>]";

export interface ProfileInstallOptions {
	profile: string;
	root: string;
	legacyAgentDir?: string;
	bridgeDir?: string;
	/** Where the template tree is read from; defaults to this checkout's `profiles/`. */
	templateRoot?: string;
}

export interface ProfileRollbackOptions {
	profile: string;
	root: string;
	/** Restore this backup instead of the most recent one. */
	backup?: string;
}

export interface ProfileUpdateResult {
	destination: string;
	/** The previous tree, moved aside intact. Rollback restores exactly this. */
	backup: string;
	/** Paths, relative to the profile's `agent` directory, kept from the previous tree. */
	carried: string[];
}

export interface ProfileRollbackResult {
	destination: string;
	/** The backup that was restored. */
	backup: string;
	/** The tree that rollback displaced, moved aside rather than deleted. */
	superseded: string;
}

function option(name: string, argv: string[]): string | undefined {
	const inline = argv.find(argument => argument.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
	try {
		await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

/** Relative paths of every regular file under `root`, deepest-first order not guaranteed. */
async function fileList(root: string, prefix = ""): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
		const relative = path.join(prefix, entry.name);
		if (entry.isDirectory()) found.push(...(await fileList(root, relative)));
		else found.push(relative);
	}
	return found;
}

function templateFor(profile: string, templateRoot?: string): string {
	return path.resolve(templateRoot ?? path.join(import.meta.dir, "..", "profiles"), profile, "agent");
}

function profilePaths(profile: string, root: string) {
	const profileRoot = path.join(root, "profiles", profile);
	return {
		profileRoot,
		destination: path.join(profileRoot, "agent"),
		backupRoot: path.join(root, "profile-backups", profile),
	};
}

/**
 * Backups live outside `profiles/`, so a moved-aside tree is never mistaken for
 * an installed profile by anything that scans that directory.
 */
async function reserve(backupRoot: string, kind: string): Promise<string> {
	await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	for (let attempt = 0; ; attempt++) {
		const candidate = path.join(backupRoot, attempt === 0 ? `${kind}-${stamp}` : `${kind}-${stamp}-${attempt}`);
		if (!(await exists(candidate))) return candidate;
	}
}

/** Move `target` out of the way. Nothing here ever deletes: recovery stays possible. */
async function moveAside(target: string, backupRoot: string, kind: string): Promise<string | undefined> {
	if (!(await exists(target))) return undefined;
	const aside = await reserve(backupRoot, kind);
	await fs.rename(target, aside);
	return aside;
}

/** Build the tree a fresh install would produce, in a directory nothing reads yet. */
async function stage(temporary: string, options: ProfileInstallOptions): Promise<void> {
	await fs.cp(templateFor(options.profile, options.templateRoot), temporary, {
		recursive: true,
		force: false,
		errorOnExist: true,
	});
	if (options.profile !== "buddha-v1") return;
	if (options.legacyAgentDir) {
		const legacy = options.legacyAgentDir;
		for (const name of LEGACY_FILES) await copyIfPresent(path.join(legacy, name), path.join(temporary, name));
		for (const name of LEGACY_DIRECTORIES) await copyIfPresent(path.join(legacy, name), path.join(temporary, name));
		for (const name of LEGACY_EXTENSIONS) {
			await copyIfPresent(path.join(legacy, "extensions", name), path.join(temporary, "extensions", name));
		}
	}
	if (options.bridgeDir) {
		await copyIfPresent(path.join(options.bridgeDir, "extension"), path.join(temporary, "extensions", "omp-live"));
	}
}

/**
 * Everything the previous tree holds that the new one does not: databases,
 * session history, terminal state, caches, and any hand-added file. The
 * template owns its own paths and wins on every collision, so an update
 * converges on what a fresh install of the same template would produce.
 */
async function carryForward(from: string, into: string, prefix = ""): Promise<string[]> {
	const carried: string[] = [];
	for (const entry of await fs.readdir(path.join(from, prefix), { withFileTypes: true })) {
		const relative = path.join(prefix, entry.name);
		const target = path.join(into, relative);
		if (!(await exists(target))) {
			await fs.cp(path.join(from, relative), target, {
				recursive: true,
				force: false,
				errorOnExist: true,
				dereference: false,
				preserveTimestamps: true,
			});
			carried.push(relative);
			continue;
		}
		if (entry.isDirectory() && (await fs.lstat(target)).isDirectory()) {
			carried.push(...(await carryForward(from, into, relative)));
		}
	}
	return carried;
}

/** Declare success only against the tree on disk, never against the copy plan. */
async function verify(destination: string, options: ProfileInstallOptions, carried: string[]): Promise<void> {
	const template = templateFor(options.profile, options.templateRoot);
	for (const relative of await fileList(template)) {
		const target = path.join(destination, relative);
		let actual: Buffer;
		try {
			actual = await fs.readFile(target);
		} catch (error) {
			throw new Error(`Verification failed: ${target} is unreadable after the swap (${errorCode(error)})`);
		}
		if (!actual.equals(await fs.readFile(path.join(template, relative)))) {
			throw new Error(`Verification failed: ${target} does not match the template`);
		}
	}
	for (const relative of carried) {
		if (!(await exists(path.join(destination, relative)))) {
			throw new Error(`Verification failed: ${relative} was carried forward but is missing from ${destination}`);
		}
	}
}

/**
 * First install. Unchanged contract: it refuses an existing destination and
 * writes through a temporary directory followed by one rename.
 */
export async function installProfile(options: ProfileInstallOptions): Promise<string> {
	const { profileRoot, destination } = profilePaths(options.profile, options.root);
	const temporary = path.join(profileRoot, `.agent.install-${process.pid}`);

	let occupied = true;
	try {
		await fs.readdir(destination);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		occupied = false;
	}
	if (occupied) throw new Error(`Profile already exists: ${destination}`);

	await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 });
	await stage(temporary, options);
	await fs.rename(temporary, destination);
	return destination;
}

/**
 * Update an existing install in place.
 *
 * The previous tree is moved aside whole before anything replaces it, the new
 * tree is swapped in with a single rename, and the result is verified on disk
 * before the call returns. Any failure past the backup restores the backup, so
 * the profile is either the new tree or the old one — never a half-update.
 */
export async function updateProfile(options: ProfileInstallOptions): Promise<ProfileUpdateResult> {
	const { profileRoot, destination, backupRoot } = profilePaths(options.profile, options.root);
	const temporary = path.join(profileRoot, `.agent.update-${process.pid}`);

	if (!(await exists(destination))) {
		throw new Error(`No profile to update: ${destination} (install it first, without --update)`);
	}

	// Staging fails before anything is moved, so a bad template or a bad
	// --legacy-agent-dir leaves the live profile untouched and running.
	try {
		await stage(temporary, options);
	} catch (error) {
		await moveAside(temporary, backupRoot, "discarded");
		throw error;
	}

	const backup = await reserve(backupRoot, "agent");
	await fs.rename(destination, backup);
	try {
		const carried = await carryForward(backup, temporary);
		await fs.rename(temporary, destination);
		await verify(destination, options, carried);
		return { destination, backup, carried };
	} catch (error) {
		await moveAside(destination, backupRoot, "failed");
		await moveAside(temporary, backupRoot, "discarded");
		await fs.rename(backup, destination);
		throw new Error(
			`Update failed and the previous profile was restored from ${backup} to ${destination}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Put a backup back. The tree it displaces is moved aside, not deleted. */
export async function rollbackProfile(options: ProfileRollbackOptions): Promise<ProfileRollbackResult> {
	const { destination, backupRoot } = profilePaths(options.profile, options.root);
	let backup = options.backup ? path.resolve(options.backup) : undefined;
	if (!backup) {
		const candidates = (await fs.readdir(backupRoot).catch(() => [] as string[]))
			.filter(name => name.startsWith("agent-"))
			.sort();
		backup = candidates.length > 0 ? path.join(backupRoot, candidates[candidates.length - 1]!) : undefined;
	}
	if (!backup || !(await exists(backup))) throw new Error(`No backup to roll back to under ${backupRoot}`);

	const superseded = await moveAside(destination, backupRoot, "superseded");
	try {
		await fs.rename(backup, destination);
	} catch (error) {
		if (superseded) await fs.rename(superseded, destination);
		throw error;
	}
	await fs.readdir(destination);
	return { destination, backup, superseded: superseded ?? "" };
}

async function main(argv: string[]): Promise<string> {
	const profile = option("--profile", argv);
	if (!profile || !PROFILE_NAMES.has(profile)) throw new Error(USAGE);
	const update = argv.includes("--update");
	const rollback = argv.includes("--rollback");
	if (update && rollback) throw new Error("Choose either --update or --rollback, not both");

	const root = path.resolve(option("--root", argv) ?? path.join(os.homedir(), ".omp"));
	if (rollback) {
		const result = await rollbackProfile({ profile, root, backup: option("--backup", argv) });
		return `${profile}\t${result.destination}\t${result.backup}\n`;
	}

	const options: ProfileInstallOptions = {
		profile,
		root,
		legacyAgentDir: option("--legacy-agent-dir", argv),
		bridgeDir: option("--bridge-dir", argv),
	};
	if (!update) return `${profile}\t${await installProfile(options)}\n`;
	const result = await updateProfile(options);
	return `${profile}\t${result.destination}\t${result.backup}\n`;
}

if (import.meta.main) process.stdout.write(await main(process.argv));
