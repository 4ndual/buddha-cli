import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { inventoryAndCopy } from "../../../src/session/repository/migration/inventory";
import { normalizeCopiedInventory } from "../../../src/session/repository/migration/normalize";

const timestamp = "2026-09-15T12:00:00.000Z";

async function inventoryFixture(source: string, backup: string) {
	return inventoryAndCopy({
		roots: [
			{
				path: source,
				rootId: "fault-fixture",
				installationNamespace: "fault-fixture",
				runtime: { name: "omp", version: "fixture-v1" },
			},
		],
		backupRoot: backup,
		snapshotAt: timestamp,
		expansionFactor: 1,
		reserveBytes: 0n,
	});
}

describe("Turso normalization fault gates", () => {
	it("keeps a SIGKILL-interrupted partial unpublished and deterministically succeeds on retry", async () => {
		using temp = TempDir.createSync("@omp-turso-normalization-kill-");
		const source = path.join(temp.path(), "source");
		const backup = path.join(temp.path(), "backup");
		const destination = path.join(temp.path(), "normalized");
		const sessions = path.join(destination, "sessions");
		await fs.mkdir(source, { recursive: true });
		await fs.mkdir(sessions, { recursive: true });
		const records = [
			JSON.stringify({ type: "session", version: 3, id: "kill-fixture", timestamp, cwd: "/team-fixture" }),
		];
		let parentId: string | null = null;
		for (let index = 0; index < 100; index += 1) {
			const id = `entry-${index}`;
			records.push(
				JSON.stringify({
					type: "custom",
					id,
					parentId,
					timestamp,
					customType: "migration.kill-fixture",
					data: { index, text: "bounded-payload" },
				}),
			);
			parentId = id;
		}
		await Bun.write(path.join(source, "session.jsonl"), `${records.join("\n")}\n`);
		const inventory = await inventoryFixture(source, backup);
		const inventoryPath = path.join(temp.path(), "inventory.json");
		await Bun.write(inventoryPath, JSON.stringify(inventory));
		const partialSeen = Promise.withResolvers<string>();
		let killChild: (() => void) | undefined;
		const watcher = watch(sessions, (_event, filename) => {
			const name = filename?.toString() ?? "";
			if (!name.includes(".partial-")) return;
			partialSeen.resolve(name);
			killChild?.();
		});
		const childPath = path.join(temp.path(), "normalize-child.ts");
		const normalizeModule = path.resolve(import.meta.dir, "../../../src/session/repository/migration/normalize.ts");
		await Bun.write(
			childPath,
			`import { normalizeCopiedInventory } from ${JSON.stringify(normalizeModule)};
const inventory = await Bun.file(${JSON.stringify(inventoryPath)}).json();
await normalizeCopiedInventory(inventory, {
	backupRoot: ${JSON.stringify(backup)},
	destinationRoot: ${JSON.stringify(destination)},
});
`,
		);
		const child = Bun.spawn([process.execPath, childPath], { cwd: temp.path(), stdout: "pipe", stderr: "pipe" });
		killChild = () => child.kill("SIGKILL");
		const outcome = await Promise.race([
			partialSeen.promise.then(partialName => ({ partialName })),
			child.exited.then(exitCode => ({ exitCode })),
		]);
		watcher.close();
		if ("exitCode" in outcome) {
			const stderr = await new Response(child.stderr).text();
			throw new Error(`normalizer exited before exposing a partial file (${outcome.exitCode}): ${stderr}`);
		}
		const exitCode = await child.exited;
		expect(exitCode).not.toBe(0);
		const partialName = outcome.partialName;
		expect(partialName).toContain(".partial-");
		const interruptedFiles = await fs.readdir(sessions);
		expect(interruptedFiles.some(name => name.endsWith(".jsonl"))).toBe(false);
		expect(interruptedFiles.some(name => name.endsWith(".manifest.json"))).toBe(false);
		expect(await Bun.file(path.join(destination, "normalization-manifest.json")).exists()).toBe(false);

		const recovered = await normalizeCopiedInventory(inventory, { backupRoot: backup, destinationRoot: destination });
		expect(recovered.summary).toMatchObject({ supplied: 1, normalized: 1, quarantined: 0 });
		const output = recovered.results[0]?.output;
		if (!output) throw new Error("normalization retry did not publish output");
		expect(await Bun.file(output.jsonlPath).exists()).toBe(true);
		expect(await Bun.file(output.manifestPath).exists()).toBe(true);
	}, 30_000);

	it("quarantines malformed JSON with an exact line and publishes no session", async () => {
		using temp = TempDir.createSync("@omp-turso-normalization-malformed-");
		const source = path.join(temp.path(), "source");
		const backup = path.join(temp.path(), "backup");
		const destination = path.join(temp.path(), "normalized");
		await fs.mkdir(source, { recursive: true });
		await fs.mkdir(destination, { recursive: true });
		await Bun.write(
			path.join(source, "malformed.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "malformed", timestamp, cwd: "/team-fixture" })}\n{"type":"custom"\n`,
		);
		const inventory = await inventoryFixture(source, backup);
		const normalized = await normalizeCopiedInventory(inventory, { backupRoot: backup, destinationRoot: destination });
		const result = normalized.results[0];

		expect(result?.status).toBe("quarantined");
		expect(result?.quarantine).toMatchObject({ code: "malformed-or-truncated-json", line: 2 });
		expect(result?.output).toBeUndefined();
		expect((await fs.readdir(path.join(destination, "sessions")).catch(() => [])).some(name => name.endsWith(".jsonl"))).toBe(
			false,
		);
	});
});
