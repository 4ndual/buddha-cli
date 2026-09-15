import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { classifySourceContent, SOURCE_ADAPTER_MATRIX } from "@oh-my-pi/pi-coding-agent/session/repository/migration/adapters";
import {
	inventoryAndCopy,
	stableSourceNamespace,
	writeInventoryOutputs,
} from "@oh-my-pi/pi-coding-agent/session/repository/migration/inventory";
import { normalizeCopiedInventory } from "@oh-my-pi/pi-coding-agent/session/repository/migration/normalize";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const temporaryRoots: string[] = [];
const SOURCE_FIXTURES = [
	"omp-v3.source.jsonl",
	"claude.source.jsonl",
	"codex.source.jsonl",
	"truncated.source.jsonl",
] as const;

async function temporaryRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-turso-inventory-test-"));
	temporaryRoots.push(root);
	return root;
}

async function fileHash(filePath: string): Promise<string> {
	return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function copySourceFixtures(destination: string): Promise<void> {
	await fs.mkdir(destination, { recursive: true });
	for (const name of SOURCE_FIXTURES) await fs.copyFile(path.join(FIXTURES, name), path.join(destination, name));
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("migration source adapters", () => {
	it("classifies formats from content rather than filenames", async () => {
		const omp = new Uint8Array(await fs.readFile(path.join(FIXTURES, "omp-v3.source.jsonl")));
		const claude = new Uint8Array(await fs.readFile(path.join(FIXTURES, "claude.source.jsonl")));
		const codex = new Uint8Array(await fs.readFile(path.join(FIXTURES, "codex.source.jsonl")));

		expect(classifySourceContent(omp, true).format).toBe("omp-jsonl-v3");
		expect(classifySourceContent(claude, true).format).toBe("claude-jsonl");
		expect(classifySourceContent(codex, true).format).toBe("codex-jsonl");
		expect(SOURCE_ADAPTER_MATRIX.find(adapter => adapter.format === "omp-jsonl-v3")?.disposition).toBe(
			"resumable",
		);
	});

	it("builds source namespaces without mutable paths", () => {
		const first = stableSourceNamespace({
			path: "/one/path",
			rootId: "profile",
			installationNamespace: "profile-a",
			runtime: { name: "omp", version: "18.1.13" },
		});
		const moved = stableSourceNamespace({
			path: "/moved/path",
			rootId: "profile",
			installationNamespace: "profile-a",
			runtime: { name: "omp", version: "18.1.13" },
		});
		expect(moved).toBe(first);
	});
});

describe("immutable source inventory", () => {
	it("accounts every discovered item, preserves originals, and verifies immutable copies", async () => {
		const root = await temporaryRoot();
		const source = path.join(root, "source");
		const backup = path.join(root, "owned-backup");
		const artifacts = path.join(root, "artifacts");
		await copySourceFixtures(source);
		await fs.writeFile(path.join(source, "credentials"), "API_TOKEN=must-not-copy\n", { mode: 0o600 });
		await fs.writeFile(path.join(source, "executable"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		await fs.writeFile(path.join(source, "binary.bin"), Uint8Array.from([0xff, 0xfe, 0, 1]));
		await fs.symlink(path.join(source, "omp-v3.source.jsonl"), path.join(source, "not-followed"));
		const names = await fs.readdir(source);
		const before = new Map<string, string>();
		for (const name of names) {
			const stats = await fs.lstat(path.join(source, name));
			if (stats.isFile()) before.set(name, await fileHash(path.join(source, name)));
		}

		const manifest = await inventoryAndCopy({
			roots: [
				{
					path: source,
					rootId: "fixture-profile",
					installationNamespace: "fixture-install",
					runtime: { name: "omp", version: "fixture" },
				},
			],
			backupRoot: backup,
			snapshotAt: "2026-09-15T00:00:00.000Z",
			expansionFactor: 1,
			reserveBytes: 0n,
		});

		expect(manifest.preflight.ok).toBe(true);
		expect(manifest.summary.discovered).toBe(names.length);
		expect(manifest.summary.accounted).toBe(names.length);
		expect(manifest.summary.pending).toBe(0);
		for (const [name, hash] of before) expect(await fileHash(path.join(source, name))).toBe(hash);
		for (const item of manifest.items) {
			expect(["copied", "excluded", "quarantined"]).toContain(item.status);
			if (item.status !== "copied") continue;
			expect(item.copied?.sha256).toBe(item.original?.sha256);
			expect(item.copied?.size).toBe(item.original?.size);
			expect((item.copied?.mode ?? 0) & 0o222).toBe(0);
			const expectedHash = item.original?.sha256;
			if (!expectedHash) throw new Error("copied item must retain its original hash");
			expect(await fileHash(item.copied?.path ?? "missing")).toBe(expectedHash);
		}
		expect(manifest.items.find(item => item.relativePath === "credentials")?.disposition?.code).toBe(
			"sensitive-material-excluded",
		);
		expect(manifest.items.find(item => item.relativePath === "executable")?.disposition?.code).toBe(
			"executable-excluded",
		);
		expect(manifest.items.find(item => item.relativePath === "binary.bin")?.disposition?.code).toBe(
			"unrecognized-binary-excluded",
		);
		expect(manifest.items.find(item => item.relativePath === "not-followed")?.disposition?.code).toBe(
			"symlink-not-followed",
		);

		const outputs = await writeInventoryOutputs(manifest, artifacts);
		const ledger = await fs.readFile(outputs.ledgerPath, "utf8");
		expect(ledger).not.toContain(source);
		expect(ledger).not.toContain(backup);
		expect(ledger.trim().split("\n")).toHaveLength(names.length);
	});

	it("marks a file pending when its descriptor state changes during the hash read", async () => {
		const root = await temporaryRoot();
		const source = path.join(root, "source");
		const sourceFile = path.join(source, "changing.jsonl");
		await fs.mkdir(source);
		await fs.writeFile(sourceFile, `${'{"value":"bounded"}\n'.repeat(100_000)}`);
		let changed = false;
		const manifest = await inventoryAndCopy({
			roots: [
				{
					path: source,
					rootId: "changing",
					installationNamespace: "changing",
					runtime: { name: "test", version: "1" },
				},
			],
			backupRoot: path.join(root, "backup"),
			maxReadAttempts: 1,
			readBytes: 4096,
			expansionFactor: 1,
			reserveBytes: 0n,
			onReadProgress: async event => {
				if (changed || event.bytesRead < 4096) return;
				changed = true;
				await fs.appendFile(event.sourcePath, '{"changed":true}\n');
			},
		});
		expect(changed).toBe(true);
		expect(manifest.items[0]?.status).toBe("pending");
		expect(manifest.items[0]?.original?.changedDuringRead).toBe(true);
		expect(manifest.items[0]?.disposition?.code).toBe("changed-during-read");
	});

	it("fails free-space preflight before creating a backup directory", async () => {
		const root = await temporaryRoot();
		const source = path.join(root, "source");
		const backup = path.join(root, "not-created", "backup");
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, "record.jsonl"), '{"value":1}\n');
		const manifest = await inventoryAndCopy({
			roots: [
				{
					path: source,
					rootId: "fixture",
					installationNamespace: "fixture",
					runtime: { name: "unknown", version: "1" },
				},
			],
			backupRoot: backup,
			reserveBytes: 2n ** 63n,
		});
		expect(manifest.preflight.ok).toBe(false);
		expect(manifest.summary.pending).toBe(1);
		expect(await fs.lstat(backup).catch(() => undefined)).toBeUndefined();
	});
});

describe("OMP v3 normalization", () => {
	it("is deterministic and idempotent, preserves unknown records, and quarantines truncation", async () => {
		const root = await temporaryRoot();
		const source = path.join(root, "source");
		const backup = path.join(root, "backup");
		const normalized = path.join(root, "normalized");
		await fs.mkdir(normalized);
		await copySourceFixtures(source);
		const fixtureNames = await fs.readdir(source);
		const before = new Map<string, string>();
		for (const name of fixtureNames) before.set(name, await fileHash(path.join(source, name)));
		const inventory = await inventoryAndCopy({
			roots: [
				{
					path: source,
					rootId: "golden",
					installationNamespace: "golden-fixtures",
					runtime: { name: "mixed", version: "fixture-v1" },
				},
			],
			backupRoot: backup,
			snapshotAt: "2026-09-15T00:00:00.000Z",
			expansionFactor: 1,
			reserveBytes: 0n,
		});
		const first = await normalizeCopiedInventory(inventory, { backupRoot: backup, destinationRoot: normalized });
		const firstOutputs = new Map<string, string>();
		for (const result of first.results) {
			if (result.output) firstOutputs.set(result.itemId, await fs.readFile(result.output.jsonlPath, "utf8"));
		}
		const second = await normalizeCopiedInventory(inventory, { backupRoot: backup, destinationRoot: normalized });

		expect(second.summary.aggregateSha256).toBe(first.summary.aggregateSha256);
		expect(second.summary.normalized).toBe(3);
		expect(second.summary.quarantined).toBe(1);
		for (const result of second.results) {
			if (!result.output) continue;
			const expectedOutput = firstOutputs.get(result.itemId);
			if (!expectedOutput) throw new Error(`missing first-pass output for ${result.itemId}`);
			expect(await fs.readFile(result.output.jsonlPath, "utf8")).toBe(expectedOutput);
		}
		for (const [sourceName, goldenName] of [
			["omp-v3.source.jsonl", "omp-v3.golden.jsonl"],
			["claude.source.jsonl", "claude.golden.jsonl"],
			["codex.source.jsonl", "codex.golden.jsonl"],
		] as const) {
			const item = inventory.items.find(candidate => candidate.relativePath === sourceName);
			const result = second.results.find(candidate => candidate.itemId === item?.itemId);
			expect(result?.status).toBe("normalized");
			expect(await fs.readFile(result?.output?.jsonlPath ?? "missing", "utf8")).toBe(
				await fs.readFile(path.join(FIXTURES, goldenName), "utf8"),
			);
		}
		const truncated = second.results.find(result => result.sourceFormat === "omp-jsonl-v3" && result.status === "quarantined");
		expect(truncated?.quarantine?.code).toBe("malformed-or-truncated-json");
		expect(truncated?.quarantine?.line).toBe(2);
		const omp = second.results.find(
			result => result.status === "normalized" && result.sourceFormat === "omp-jsonl-v3",
		);
		const ompOutput = omp?.output ? await fs.readFile(omp.output.jsonlPath, "utf8") : "";
		expect(ompOutput).toContain('"customType":"migration.provenance.v1"');
		expect(ompOutput).toContain('"originalType":"future_control"');
		expect(ompOutput).toContain('"toolExecution":"never-replayed"');
		for (const [name, hash] of before) expect(await fileHash(path.join(source, name))).toBe(hash);
	});

	it("quarantines loss-unsafe integers and record quota violations with explicit reasons", async () => {
		const root = await temporaryRoot();
		const source = path.join(root, "source");
		const backup = path.join(root, "backup");
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, "unsafe.jsonl"), '{"native":9007199254740993}\n');
		const inventory = await inventoryAndCopy({
			roots: [
				{
					path: source,
					rootId: "unsafe",
					installationNamespace: "unsafe",
					runtime: { name: "other", version: "1" },
				},
			],
			backupRoot: backup,
			expansionFactor: 1,
			reserveBytes: 0n,
		});
		const destinationRoot = path.join(root, "normalized");
		await fs.mkdir(destinationRoot);
		const result = await normalizeCopiedInventory(inventory, {
			backupRoot: backup,
			destinationRoot,
		});
		expect(result.results[0]?.quarantine?.code).toBe("unsafe-json-integer");
	});
});
