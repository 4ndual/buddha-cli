import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertSafeDestination, copyStableFile, inventory, type InventoryRoot } from "./inventory";
import { isGitHubSessionCandidate } from "./github-ledger";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wcdb-inventory-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("inventory destination safety", () => {
	test("rejects a destination nested beneath a source root before writing", async () => {
		const root = await temporaryDirectory();
		const roots: InventoryRoot[] = [{ name: "source", harness: "omp", namespace: "test", path: root, policy: "session-tree" }];
		await expect(assertSafeDestination(path.join(root, "copies"), roots)).rejects.toThrow("Destination must not be inside source root source");
		expect(await Bun.file(path.join(root, "copies")).exists()).toBe(false);
	});

	test("rejects a symbolic-link source root rather than traversing it", async () => {
		const parent = await temporaryDirectory();
		const source = path.join(parent, "source");
		const link = path.join(parent, "source-link");
		const destination = path.join(parent, "destination");
		await fs.mkdir(source);
		await fs.symlink(source, link);
		const roots: InventoryRoot[] = [{ name: "linked", harness: "omp", namespace: "test", path: link, policy: "session-tree" }];
		await expect(assertSafeDestination(destination, roots)).rejects.toThrow("Source root is a symbolic link");
	});
});

describe("stable source copying", () => {
	test("retries when the source changes and receipts hash the stable retry", async () => {
		const parent = await temporaryDirectory();
		const source = path.join(parent, "session.jsonl");
		const destination = path.join(parent, "copies");
		await fs.mkdir(destination);
		await Bun.write(source, '{"type":"session","version":3,"id":"first"}\n');
		const outcome = await copyStableFile(source, destination, 1, async (_source, attempt) => {
			if (attempt === 1) {
				await Bun.write(source, '{"type":"session","version":3,"id":"second"}\n');
			}
		});
		expect("copy" in outcome).toBe(true);
		if (!("copy" in outcome)) throw new Error("Expected stable retry to copy");
		expect(outcome.attempts).toBe(2);
		expect(outcome.before).toBe(outcome.after);
		expect(outcome.copy).toBe(outcome.after);
		expect(await Bun.file(outcome.copyPath).text()).toContain('"id":"second"');
	});

	test("leaves an exhausted changing source pending with explicit accounting", async () => {
		const parent = await temporaryDirectory();
		const sourceRoot = path.join(parent, "source");
		const destination = path.join(parent, "copies");
		await fs.mkdir(sourceRoot);
		const source = path.join(sourceRoot, "session.jsonl");
		await Bun.write(source, '{"type":"session","version":3,"id":"unstable"}\n');
		const roots: InventoryRoot[] = [{ name: "source", harness: "omp", namespace: "test", path: sourceRoot, policy: "session-tree" }];
		let revision = 0;
		const report = await inventory({
			roots,
			destination,
			since: new Date(0),
			mode: "copy",
			retries: 1,
			afterCopyAttempt: async () => {
				await Bun.write(source, `{"type":"session","version":3,"id":"unstable-${revision++}"}\n`);
			},
		});
		expect(report.records).toHaveLength(1);
		expect(report.records[0]?.disposition).toBe("pending");
		expect(report.records[0]?.reason).toBe("source-changed-during-copy");
		expect(report.records[0]?.attempts).toBe(2);
		expect(report.totals.byDisposition.pending.records).toBe(1);
		expect(report.noProductionMutation.originalsStable).toBe(false);
	});

	test("excludes secret-bearing paths without hashing or copying their values", async () => {
		const parent = await temporaryDirectory();
		const sourceRoot = path.join(parent, "source");
		const destination = path.join(parent, "copies");
		await fs.mkdir(sourceRoot);
		const source = path.join(sourceRoot, "oauth-token.json");
		await Bun.write(source, '{\"access_token\":\"must-not-copy\"}\\n');
		const roots: InventoryRoot[] = [{ name: "source", harness: "other", namespace: "test", path: sourceRoot, policy: "session-tree" }];
		const report = await inventory({ roots, destination, since: new Date(0), mode: "copy" });
		expect(report.records[0]?.disposition).toBe("excluded");
		expect(report.records[0]?.reason).toBe("excluded-secret-path");
		expect(report.records[0]?.sha256Before).toBeNull();
		expect(report.records[0]?.copyPath).toBeNull();
		expect(await Bun.file(source).text()).toContain("must-not-copy");
	});

	test("accounts verified existing objects as resumable preflight capacity", async () => {
		const parent = await temporaryDirectory();
		const sourceRoot = path.join(parent, "source");
		const destination = path.join(parent, "copies");
		await fs.mkdir(sourceRoot);
		const content = '{"type":"session","version":3,"id":"resumable"}\n';
		await Bun.write(path.join(sourceRoot, "session.jsonl"), content);
		const roots: InventoryRoot[] = [{ name: "source", harness: "omp", namespace: "test", path: sourceRoot, policy: "session-tree" }];
		await inventory({ roots, destination, since: new Date(0), mode: "copy" });
		const resumed = await inventory({ roots, destination, since: new Date(0), mode: "copy" });
		expect(resumed.preflight.existingCopyBytes).toBe(new TextEncoder().encode(content).byteLength);
		expect(resumed.preflight.remainingCopyBytes).toBe(0);
		expect(resumed.records[0]?.disposition).toBe("copied");
	});
});

describe("source adapter accounting", () => {
	test("recognizes legacy OMP v1 headers with inferred provenance", async () => {
		const parent = await temporaryDirectory();
		const sourceRoot = path.join(parent, "source");
		await fs.mkdir(sourceRoot);
		await Bun.write(path.join(sourceRoot, "legacy.jsonl"), '{"type":"session","id":"legacy","cwd":"/workspace","timestamp":"2026-01-01T00:00:00.000Z"}\n');
		const roots: InventoryRoot[] = [{ name: "legacy", harness: "omp", namespace: "test", path: sourceRoot, policy: "session-tree" }];
		const report = await inventory({ roots, destination: path.join(parent, "copies"), since: new Date(0), mode: "plan" });
		expect(report.records[0]?.format).toBe("omp-jsonl");
		expect(report.records[0]?.reason).toBe("recognized-legacy-v1-session-header");
		expect(report.records[0]?.observations).toContainEqual(expect.objectContaining({ field: "schemaVersion", value: 1, status: "inferred" }));
		expect(report.adapterMatrix[0]?.capability).toBe("supported");
	});

	test("marks JCode session JSON as adapter-supported", async () => {
		const parent = await temporaryDirectory();
		const sourceRoot = path.join(parent, "source");
		await fs.mkdir(sourceRoot);
		await Bun.write(path.join(sourceRoot, "session.json"), '{"id":"jcode-1","messages":[],"working_dir":"/workspace"}\n');
		const roots: InventoryRoot[] = [{ name: "jcode", harness: "jcode", namespace: "test", path: sourceRoot, policy: "session-tree" }];
		const report = await inventory({ roots, destination: path.join(parent, "copies"), since: new Date(0), mode: "plan" });
		expect(report.records[0]?.format).toBe("jcode-session-json");
		expect(report.adapterMatrix[0]?.capability).toBe("supported");
	});
});

test("discovers nested session JSON fixtures without treating source files as archives", () => {
	expect(isGitHubSessionCandidate("crates/pi-edit/tests/fixtures/hashline/parity_recovery_session_chain.json")).toBe(true);
	expect(isGitHubSessionCandidate("packages/coding-agent/test/fixtures/before-compaction.jsonl")).toBe(true);
	expect(isGitHubSessionCandidate("packages/coding-agent/src/session/session-manager.ts")).toBe(false);
});
