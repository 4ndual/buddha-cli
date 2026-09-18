import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installProfile, rollbackProfile, updateProfile } from "./install-profile";

const repoTemplates = path.resolve(import.meta.dir, "..", "profiles");
const spent = path.join(os.tmpdir(), `install-profile-spent-${process.pid}`);
const roots: string[] = [];

/** Throwaway roots are moved aside when the suite ends; nothing here deletes. */
afterAll(async () => {
	await fs.mkdir(spent, { recursive: true });
	for (const root of roots) {
		await fs.rename(root, path.join(spent, path.basename(root))).catch(() => undefined);
	}
});

async function throwawayRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "install-profile-root-"));
	roots.push(root);
	return root;
}

async function write(file: string, body: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, body);
}

/** A stand-in profile template, so a test can ship a second revision of it. */
async function templateRoot(revision: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "install-profile-template-"));
	roots.push(root);
	const agent = path.join(root, "buddha-v1", "agent");
	await write(path.join(agent, "runtime.ts"), `export const revision = "${revision}";\n`);
	await write(path.join(agent, "extensions", "buddha-runtime", "inbox.ts"), `// inbox ${revision}\n`);
	await write(path.join(agent, "runtime", "router.ts"), `// router ${revision}\n`);
	return root;
}

async function manifest(root: string, prefix = ""): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
		const relative = path.join(prefix, entry.name);
		if (entry.isDirectory()) Object.assign(entries, await manifest(root, relative));
		else
			entries[relative] = createHash("sha256")
				.update(await fs.readFile(path.join(root, relative)))
				.digest("hex");
	}
	return entries;
}

/**
 * A profile is "working" when every file the template owns is on disk with the
 * template's bytes: that is what the CLI loads at startup.
 */
async function expectMatchesTemplate(destination: string, template: string): Promise<void> {
	for (const [relative, digest] of Object.entries(await manifest(template))) {
		expect(`${relative}:${(await manifest(destination))[relative]}`).toBe(`${relative}:${digest}`);
	}
}

/** The mutable runtime state a live profile accumulates outside the template. */
async function seedRuntimeState(destination: string): Promise<void> {
	await write(path.join(destination, "agent.db"), "sqlite-ish bytes");
	await write(path.join(destination, "AGENTS.md"), "user rules");
	await write(path.join(destination, "sessions", "root.jsonl"), '{"type":"session"}\n');
	await write(path.join(destination, "extensions", "peek.ts"), "// hand-added extension\n");
}

describe("install-profile first install", () => {
	test("installs the repository template and still refuses a second install", async () => {
		const root = await throwawayRoot();
		const destination = await installProfile({ profile: "buddha-v1", root, templateRoot: repoTemplates });

		expect(destination).toBe(path.join(root, "profiles", "buddha-v1", "agent"));
		await expectMatchesTemplate(destination, path.join(repoTemplates, "buddha-v1", "agent"));
		await expect(installProfile({ profile: "buddha-v1", root, templateRoot: repoTemplates })).rejects.toThrow(
			`Profile already exists: ${destination}`,
		);
	});

	test("refuses to update a profile that was never installed", async () => {
		const root = await throwawayRoot();
		await expect(updateProfile({ profile: "buddha-v1", root, templateRoot: repoTemplates })).rejects.toThrow(
			"No profile to update",
		);
	});
});

describe("install-profile update", () => {
	test("replaces template files, keeps runtime state, and leaves the backup intact", async () => {
		const root = await throwawayRoot();
		const first = await templateRoot("v1");
		const second = await templateRoot("v2");
		const destination = await installProfile({ profile: "buddha-v1", root, templateRoot: first });
		await seedRuntimeState(destination);
		const before = await manifest(destination);

		const result = await updateProfile({ profile: "buddha-v1", root, templateRoot: second });

		expect(result.destination).toBe(destination);
		await expectMatchesTemplate(destination, path.join(second, "buddha-v1", "agent"));
		expect(await fs.readFile(path.join(destination, "runtime.ts"), "utf8")).toBe('export const revision = "v2";\n');
		// Everything the new template does not own survived the swap: a whole
		// subtree when the template has no such directory, file by file when it does.
		expect(result.carried.sort()).toEqual(
			["AGENTS.md", "agent.db", path.join("extensions", "peek.ts"), "sessions"].sort(),
		);
		expect(await fs.readFile(path.join(destination, "agent.db"), "utf8")).toBe("sqlite-ish bytes");
		expect(await fs.readFile(path.join(destination, "sessions", "root.jsonl"), "utf8")).toBe('{"type":"session"}\n');
		// The backup is the previous tree, byte for byte, outside profiles/.
		expect(result.backup.startsWith(path.join(root, "profile-backups", "buddha-v1"))).toBe(true);
		expect(await manifest(result.backup)).toEqual(before);
	});

	test("is idempotent: updating twice in a row leaves a working profile both times", async () => {
		const root = await throwawayRoot();
		const first = await templateRoot("v1");
		const second = await templateRoot("v2");
		const destination = await installProfile({ profile: "buddha-v1", root, templateRoot: first });
		await seedRuntimeState(destination);

		const once = await updateProfile({ profile: "buddha-v1", root, templateRoot: second });
		const afterOnce = await manifest(destination);
		await expectMatchesTemplate(destination, path.join(second, "buddha-v1", "agent"));

		const twice = await updateProfile({ profile: "buddha-v1", root, templateRoot: second });
		await expectMatchesTemplate(destination, path.join(second, "buddha-v1", "agent"));
		expect(await manifest(destination)).toEqual(afterOnce);
		expect(twice.carried.sort()).toEqual(once.carried.sort());
		expect(twice.backup).not.toBe(once.backup);
		expect(await manifest(twice.backup)).toEqual(afterOnce);
	});
});

describe("install-profile rollback", () => {
	test("restores the backup and moves the rolled-back tree aside", async () => {
		const root = await throwawayRoot();
		const first = await templateRoot("v1");
		const second = await templateRoot("v2");
		const destination = await installProfile({ profile: "buddha-v1", root, templateRoot: first });
		await seedRuntimeState(destination);
		const before = await manifest(destination);

		const updated = await updateProfile({ profile: "buddha-v1", root, templateRoot: second });
		const afterUpdate = await manifest(destination);
		const rolled = await rollbackProfile({ profile: "buddha-v1", root });

		expect(rolled.backup).toBe(updated.backup);
		expect(await manifest(destination)).toEqual(before);
		await expectMatchesTemplate(destination, path.join(first, "buddha-v1", "agent"));
		// The update is not lost either: it is parked, not deleted.
		expect(await manifest(rolled.superseded)).toEqual(afterUpdate);
	});
});

describe("install-profile failed update", () => {
	test("restores the original profile when the swap cannot complete", async () => {
		const root = await throwawayRoot();
		const first = await templateRoot("v1");
		const second = await templateRoot("v2");
		const destination = await installProfile({ profile: "buddha-v1", root, templateRoot: first });
		await seedRuntimeState(destination);
		const before = await manifest(destination);

		// A real I/O failure past the backup: an unreadable file the update must
		// carry forward. Everything before this point already succeeded.
		const unreadable = path.join(destination, "agent.db");
		await fs.chmod(unreadable, 0o000);
		await expect(updateProfile({ profile: "buddha-v1", root, templateRoot: second })).rejects.toThrow(
			"Update failed and the previous profile was restored",
		);
		await fs.chmod(unreadable, 0o644);

		expect(await manifest(destination)).toEqual(before);
		await expectMatchesTemplate(destination, path.join(first, "buddha-v1", "agent"));
		expect(await fs.readFile(path.join(destination, "runtime.ts"), "utf8")).toBe('export const revision = "v1";\n');
		// The profile still updates cleanly once the fault is gone.
		await updateProfile({ profile: "buddha-v1", root, templateRoot: second });
		await expectMatchesTemplate(destination, path.join(second, "buddha-v1", "agent"));
	});
});

describe("install-profile command line", () => {
	test("installs, updates, and rolls back through the script's own entry point", async () => {
		const root = await throwawayRoot();
		const script = path.join(import.meta.dir, "install-profile.ts");
		const run = async (...args: string[]) => {
			const result = Bun.spawnSync([process.execPath, script, "--profile", "chat", "--root", root, ...args]);
			expect(`${args.join(" ")}: ${result.stderr.toString()}`).toBe(`${args.join(" ")}: `);
			return result.stdout.toString().trim().split("\t");
		};

		const [, destination] = await run();
		expect(destination).toBe(path.join(root, "profiles", "chat", "agent"));
		await write(path.join(destination!, "agent.db"), "live state");

		const [, updated, backup] = await run("--update");
		expect(updated).toBe(destination);
		expect(await fs.readFile(path.join(destination!, "agent.db"), "utf8")).toBe("live state");
		await expectMatchesTemplate(destination!, path.join(repoTemplates, "chat", "agent"));

		const [, restored, source] = await run("--rollback");
		expect(restored).toBe(destination);
		expect(source).toBe(backup);
		await expectMatchesTemplate(destination!, path.join(repoTemplates, "chat", "agent"));
	});
});
