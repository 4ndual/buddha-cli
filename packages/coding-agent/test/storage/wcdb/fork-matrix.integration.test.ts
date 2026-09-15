import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionHeader } from "../../../src/session/session-entries";
import { parseSessionContent } from "../../../src/session/session-loader";
import { hasWcdbTestAdapter, type JsonValue, WcdbMigrationTestDriver } from "./migration-test-driver";

interface ImportResult extends Record<string, JsonValue> {
	committed: number;
	idempotent: number;
	siblingForks: number;
	metadataVersions: number;
	quarantined: number;
	originIds: string[];
	branchIds: string[];
	headHashes: string[];
}

interface AppendResult extends Record<string, JsonValue> {
	status: "committed" | "idempotent" | "sibling-fork";
	branchId: string;
	eventHash: string;
	parentHash: string;
	forkPointHash: string | null;
}

interface MatrixSnapshot extends Record<string, JsonValue> {
	originIds: string[];
	branchIds: string[];
	versionIds: string[];
	headHashes: string[];
	aliases: string[];
	unresolvedOrigins: string[];
	quarantineReasons: string[];
}

interface SyncResult extends Record<string, JsonValue> {
	newVersions: number;
	siblingForks: number;
	duplicates: number;
	quarantined: number;
	deletionsApplied: number;
	retainedOriginIds: string[];
}

interface ExportResult extends Record<string, JsonValue> {
	bundlePath: string;
}

const fixtureDir = path.resolve(import.meta.dir, "../../fixtures/wcdb");
const integrationIt = it.skipIf(!hasWcdbTestAdapter);

async function writeVariant(
	destination: string,
	mutate: (entries: FileEntry[]) => void,
): Promise<string> {
	const source = await Bun.file(path.join(fixtureDir, "omp-v3-complete.jsonl")).text();
	const entries = structuredClone(parseSessionContent(source).entries);
	mutate(entries);
	await Bun.write(destination, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return destination;
}

async function snapshot(driver: WcdbMigrationTestDriver): Promise<MatrixSnapshot> {
	return driver.invoke<MatrixSnapshot>("forkMatrixSnapshot");
}

describe("WCDB no-merge fork matrix", () => {
	integrationIt("turns one simultaneous expected-head CAS loser into a sibling branch without reparenting", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-cas-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await driver.invoke("reset", {});
		const imported = await driver.invoke<ImportResult>("importArchive", {
			source: path.join(fixtureDir, "omp-v3-complete.jsonl"),
			sourceNamespace: "omp-v3",
			replicaId: "cas-source",
		});
		const branchId = imported.branchIds[0];
		const expectedHead = imported.headHashes[0];
		if (!branchId || !expectedHead) throw new Error("Fixture import did not create a writable branch");
		const [left, right] = await Promise.all([
			driver.invoke<AppendResult>("append", {
				branchId,
				expectedHead,
				event: { nativeEntryId: "race-left", parentHash: expectedHead, semanticPayload: { text: "left" } },
			}),
			driver.invoke<AppendResult>("append", {
				branchId,
				expectedHead,
				event: { nativeEntryId: "race-right", parentHash: expectedHead, semanticPayload: { text: "right" } },
			}),
		]);
		expect([left.status, right.status].sort()).toEqual(["committed", "sibling-fork"]);
		expect(left.branchId).not.toBe(right.branchId);
		expect(left.parentHash).toBe(expectedHead);
		expect(right.parentHash).toBe(expectedHead);
		expect([left.forkPointHash, right.forkPointHash]).toContain(expectedHead);
		expect(left.eventHash).not.toBe(right.eventHash);
	});

	integrationIt("preserves old versions for historical edits, title-only metadata edits, and truncation", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-edits-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const historical = await writeVariant(path.join(workspace.path(), "historical-edit.jsonl"), entries => {
			const tool = entries.find(entry => entry.type === "message" && entry.id === "t1");
			if (!tool || tool.type !== "message" || tool.message.role !== "toolResult") throw new Error("Missing tool result");
			tool.message.content = [{ type: "text", text: "historically edited result" }];
		});
		const titleOnly = await writeVariant(path.join(workspace.path(), "title-only.jsonl"), entries => {
			const header = entries[0] as SessionHeader;
			header.title = "Metadata-only divergent title";
			header.titleSource = "user";
		});
		const truncated = await writeVariant(path.join(workspace.path(), "truncated-history.jsonl"), entries => {
			entries.splice(-3);
		});

		await driver.invoke("reset", {});
		await driver.invoke("importArchive", {
			source: path.join(fixtureDir, "omp-v3-complete.jsonl"),
			sourceNamespace: "omp-v3",
			replicaId: "edit-source",
		});
		const before = await snapshot(driver);
		const historicalResult = await driver.invoke<ImportResult>("importArchive", {
			source: historical,
			sourceNamespace: "omp-v3",
			replicaId: "edit-source",
		});
		expect(historicalResult.siblingForks).toBe(1);
		const titleResult = await driver.invoke<ImportResult>("importArchive", {
			source: titleOnly,
			sourceNamespace: "omp-v3",
			replicaId: "edit-source",
		});
		expect(titleResult.metadataVersions).toBe(1);
		const truncationResult = await driver.invoke<ImportResult>("importArchive", {
			source: truncated,
			sourceNamespace: "omp-v3",
			replicaId: "edit-source",
		});
		expect(truncationResult.siblingForks).toBe(1);
		const after = await snapshot(driver);
		for (const oldVersion of before.versionIds) expect(after.versionIds).toContain(oldVersion);
		for (const oldHead of before.headHashes) expect(after.headHashes).toContain(oldHead);
		expect(after.versionIds.length).toBe(before.versionIds.length + 3);
	});

	integrationIt("treats rename, lost sidecar with embedded provenance, reordered serialization, and copied export as idempotent", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-idempotence-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const source = path.join(fixtureDir, "omp-v3-complete.jsonl");
		const renamed = path.join(workspace.path(), "renamed-copy.jsonl");
		await Bun.write(renamed, Bun.file(source));
		await driver.invoke("reset", {});
		await driver.invoke("importArchive", {
			source,
			sourceNamespace: "omp-v3",
			replicaId: "idempotence-source",
		});
		const baseline = await snapshot(driver);
		const renamedResult = await driver.invoke<ImportResult>("importArchive", {
			source: renamed,
			sourceNamespace: "omp-v3",
			replicaId: "idempotence-source",
			sidecar: "missing",
		});
		expect(renamedResult.idempotent).toBe(1);
		expect(renamedResult.committed).toBe(0);
		expect(renamedResult.originIds).toEqual(baseline.originIds);
		const reorderedAResult = await driver.invoke<ImportResult>("importArchive", {
			source: path.join(fixtureDir, "reordered-tree-a.jsonl"),
			sourceNamespace: "reordered-tree",
			replicaId: "idempotence-source",
			sidecar: "missing",
		});
		expect(reorderedAResult.committed).toBe(1);
		expect(reorderedAResult.quarantined).toBe(0);
		const reorderedFirst = await snapshot(driver);
		const reorderedResult = await driver.invoke<ImportResult>("importArchive", {
			source: path.join(fixtureDir, "reordered-tree-b.jsonl"),
			sourceNamespace: "reordered-tree",
			replicaId: "idempotence-source",
		});
		expect(reorderedResult.idempotent).toBe(1);
		expect((await snapshot(driver)).branchIds).toEqual(reorderedFirst.branchIds);

		const exported = await driver.invoke<ExportResult>("exportArchive", {
			destination: path.join(workspace.path(), "published-export"),
			allBranches: true,
		});
		const copied = path.join(workspace.path(), "copied-export");
		await fs.cp(exported.bundlePath, copied, { recursive: true });
		const copiedResult = await driver.invoke<ImportResult>("importArchive", {
			source: copied,
			sourceNamespace: "omp-export",
			replicaId: "copied-replica",
		});
		expect(copiedResult.siblingForks).toBe(0);
		expect(copiedResult.committed).toBe(0);
		for (const originId of baseline.originIds) expect((await snapshot(driver)).originIds).toContain(originId);
	});

	integrationIt("namespaces duplicate native IDs across harnesses and quarantines malformed, cyclic, and missing-parent inputs", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-quarantine-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await driver.invoke("reset", {});
		const harnessA = await driver.invoke<ImportResult>("importArchive", {
			source: path.join(fixtureDir, "duplicate-id-harness-a.jsonl"),
			sourceNamespace: "harness-a",
			replicaId: "duplicates",
		});
		const harnessB = await driver.invoke<ImportResult>("importArchive", {
			source: path.join(fixtureDir, "duplicate-id-harness-b.jsonl"),
			sourceNamespace: "harness-b",
			replicaId: "duplicates",
		});
		expect(harnessA.originIds[0]).not.toBe(harnessB.originIds[0]);
		for (const [fixture, reason] of [
			["malformed-and-truncated.jsonl", "malformed"],
			["cyclic.jsonl", "cycle"],
			["missing-parent.jsonl", "missing-parent"],
		] as const) {
			const result = await driver.invoke<ImportResult>("importArchive", {
				source: path.join(fixtureDir, fixture),
				sourceNamespace: `corrupt:${fixture}`,
				replicaId: "quarantine",
			});
			expect(result.quarantined).toBe(1);
			expect((await snapshot(driver)).quarantineReasons).toContain(reason);
		}
	});

	integrationIt("does not propagate deletion from absence or explicit delete requests and converges in either sync order", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-sync-order-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const left = await writeVariant(path.join(workspace.path(), "left.jsonl"), entries => {
			entries.push({
				type: "custom",
				id: "left-extension",
				parentId: "u2",
				timestamp: "2026-04-01T00:00:00.000Z",
				customType: "fixture.branch",
				data: { side: "left" },
			});
		});
		const right = await writeVariant(path.join(workspace.path(), "right.jsonl"), entries => {
			entries.push({
				type: "custom",
				id: "right-extension",
				parentId: "u2",
				timestamp: "2026-04-01T00:00:00.000Z",
				customType: "fixture.branch",
				data: { side: "right" },
			});
		});
		const emptySource = path.join(workspace.path(), "empty-source");
		await fs.mkdir(emptySource);

		await driver.invoke("reset", { database: "left-right" });
		await driver.invoke("importArchive", {
			source: path.join(fixtureDir, "omp-v3-complete.jsonl"),
			sourceNamespace: "omp-v3",
			replicaId: "sync-base",
		});
		const retainedOrigin = (await snapshot(driver)).originIds[0];
		if (!retainedOrigin) throw new Error("Missing base origin");
		const deletion = await driver.invoke<SyncResult>("synchronize", {
			direction: "jsonl-to-db",
			sources: [emptySource],
			deletionCandidates: [retainedOrigin],
		});
		expect(deletion.deletionsApplied).toBe(0);
		expect(deletion.retainedOriginIds).toContain(retainedOrigin);
		await driver.invoke<SyncResult>("synchronize", {
			direction: "jsonl-to-db",
			sources: [left, right],
			sourceNamespace: "omp-v3",
		});
		const leftRight = await snapshot(driver);
		const repeat = await driver.invoke<SyncResult>("synchronize", {
			direction: "db-to-jsonl-to-db",
			sources: [left, right],
			sourceNamespace: "omp-v3",
		});
		expect(repeat.newVersions).toBe(0);
		expect(repeat.siblingForks).toBe(0);
		expect((await snapshot(driver)).branchIds).toEqual(leftRight.branchIds);

		await driver.invoke("reset", { database: "right-left" });
		await driver.invoke("importArchive", {
			source: path.join(fixtureDir, "omp-v3-complete.jsonl"),
			sourceNamespace: "omp-v3",
			replicaId: "sync-base",
		});
		await driver.invoke<SyncResult>("synchronize", {
			direction: "jsonl-to-db",
			sources: [right, left],
			sourceNamespace: "omp-v3",
		});
		const rightLeft = await snapshot(driver);
		expect(rightLeft.originIds).toEqual(leftRight.originIds);
		expect(rightLeft.headHashes.sort()).toEqual(leftRight.headHashes.sort());
		expect(rightLeft.branchIds.sort()).toEqual(leftRight.branchIds.sort());
	});
});
