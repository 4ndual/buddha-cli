import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ExperimentalModeTransition,
	ModeTransitionInterruptedError,
	assertWriteFence,
} from "../../src/storage/fencing/mode-transition";
import { checksumJobJson, sha256Bytes } from "../../src/storage/jobs/checksum";
import type { DurableIo } from "../../src/storage/jobs/durable-fs";
import { durableIo } from "../../src/storage/jobs/durable-fs";
import {
	publishExportGeneration,
	repairPublicationReceipt,
	type ExportGenerationFile,
	type ExportPublicationReceipt,
	type ExportReceiptStore,
} from "../../src/storage/jobs/export-generation";
import { DurableJobJournal } from "../../src/storage/jobs/journal";
import {
	ReplicaBranchMappingStore,
	reconcileAndPersistSameOrigin,
} from "../../src/storage/jobs/replica-mappings";
import {
	reconcileSameOrigin,
	type ReplicaBranchMapping,
	type SyncVersionSnapshot,
} from "../../src/storage/jobs/reconcile";
import { runByteBoundedJob, type ByteBoundedJobItem, type DurableBatchReceipt } from "../../src/storage/jobs/runner";
import { createVerifiedBackup, salvageOnCopy } from "../../src/storage/recovery/backup";
import { createSchemaRollbackGate, assertSchemaRollbackGate } from "../../src/storage/recovery/schema-gate";
import { runStandaloneRecovery } from "../../src/storage/recovery/standalone";
type ReplicaIdForTest = Parameters<typeof reconcileSameOrigin>[0]["targetReplicaId"];

const temporaryRoots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-wcdb-${label}-`));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class MemoryReceiptStore implements ExportReceiptStore {
	readonly receipts = new Map<string, ExportPublicationReceipt>();

	async lookup(generation: string): Promise<ExportPublicationReceipt | null> {
		return this.receipts.get(generation) ?? null;
	}

	async record(receipt: ExportPublicationReceipt): Promise<void> {
		const existing = this.receipts.get(receipt.generation);
		if (existing && existing.manifestChecksum !== receipt.manifestChecksum) throw new Error("receipt collision");
		this.receipts.set(receipt.generation, receipt);
	}
}

async function* oneExportFile(content = "A\n"): AsyncIterable<ExportGenerationFile> {
	yield { relativePath: "sessions/session.jsonl", content };
}

function syncVersion(input: {
	origin: string;
	version: string;
	branch: string;
	parent?: string;
	events: string[];
	metadata?: string;
}): SyncVersionSnapshot {
	return {
		originId: input.origin as SyncVersionSnapshot["originId"],
		versionId: input.version as SyncVersionSnapshot["versionId"],
		branchId: input.branch as SyncVersionSnapshot["branchId"],
		parentVersionId: (input.parent ?? null) as SyncVersionSnapshot["parentVersionId"],
		headHash: (input.events.at(-1) ?? null) as SyncVersionSnapshot["headHash"],
		metadataRevisionId: (input.metadata ?? "m1") as SyncVersionSnapshot["metadataRevisionId"],
		eventHashes: input.events as unknown as SyncVersionSnapshot["eventHashes"],
	};
}

describe("durable byte-bounded jobs", () => {
	test("recovers a repository-acknowledged commit after the journal write crashes", async () => {
		const root = await temporaryRoot("job-ack");
		let failStateRename = false;
		let faultConsumed = false;
		const faultIo: DurableIo = {
			...durableIo,
			async rename(source, destination) {
				if (failStateRename && !faultConsumed && destination.endsWith("state.json")) {
					faultConsumed = true;
					failStateRename = false;
					const error = new Error("disk full") as Error & { code: string };
					error.code = "ENOSPC";
					throw error;
				}
				await durableIo.rename(source, destination);
			},
		};
		const journal = await DurableJobJournal.create(path.join(root, "job"), {
			jobId: "import-1",
			kind: "import",
			byteLimit: 4,
			io: faultIo,
		});
		const items: ByteBoundedJobItem<string>[] = [
			{ cursor: "", nextCursor: "1", byteLength: 3, contentChecksum: sha256Bytes("one"), value: "one" },
			{ cursor: "1", nextCursor: "2", byteLength: 3, contentChecksum: sha256Bytes("two"), value: "two" },
		];
		const durableReceipts = new Map<string, DurableBatchReceipt>();
		const applied: string[] = [];
		const executor = {
			async lookupReceipt(commitId: string) {
				return durableReceipts.get(commitId) ?? null;
			},
			async commit(batch: readonly ByteBoundedJobItem<string>[], context: { commitId: string; effectChecksum: string }) {
				applied.push(...batch.map(item => item.value));
				const receipt = {
					...context,
					receiptChecksum: checksumJobJson({ commitId: context.commitId, effectChecksum: context.effectChecksum }),
				};
				durableReceipts.set(context.commitId, receipt);
				if (applied.length === 1) failStateRename = true;
				return receipt;
			},
		};
		const itemsFrom = async function* (cursor: string) {
			const index = cursor === "" ? 0 : Number(cursor);
			for (const item of items.slice(index)) yield item;
		};

		await expect(runByteBoundedJob({ journal, itemsFrom, executor })).rejects.toThrow("disk full");
		expect(applied).toEqual(["one"]);
		const reopened = await DurableJobJournal.open(path.join(root, "job"));
		const result = await runByteBoundedJob({ journal: reopened, itemsFrom, executor });
		expect(result).toEqual({ state: "completed", commits: 2, committedBytes: 6, recoveredReceipts: 1 });
		expect(applied).toEqual(["one", "two"]);
	});

	test("leaves a busy batch resumable without advancing its cursor", async () => {
		const root = await temporaryRoot("job-busy");
		const journal = await DurableJobJournal.create(path.join(root, "job"), {
			jobId: "sync-busy",
			kind: "sync",
			byteLimit: 8,
		});
		const item: ByteBoundedJobItem<string> = {
			cursor: "",
			nextCursor: "1",
			byteLength: 4,
			contentChecksum: sha256Bytes("busy"),
			value: "busy",
		};
		const itemsFrom = async function* () {
			yield item;
		};
		await expect(
			runByteBoundedJob({
				journal,
				itemsFrom,
				executor: {
					async lookupReceipt() {
						return null;
					},
					async commit() {
						const error = new Error("database busy") as Error & { code: string };
						error.code = "SQLITE_BUSY";
						throw error;
					},
				},
			}),
		).rejects.toThrow("database busy");
		expect(journal.snapshot.phase).toBe("running");
		expect(journal.snapshot.nextCursor).toBe("");
		expect(journal.snapshot.commits).toEqual([]);
	});
});

describe("export publication and receipt repair", () => {
	test("never publishes a partial generation and can retry after a kill point", async () => {
		const root = await temporaryRoot("export-kill");
		const receipts = new MemoryReceiptStore();
		await expect(
			publishExportGeneration({
				root,
				generation: "gen-1",
				publication: "same-filesystem",
				cutoffs: [],
				files: oneExportFile(),
				receipts,
				validate: async () => undefined,
				fault: async point => {
					if (point === "after-manifest") throw new Error("simulated kill");
				},
			}),
		).rejects.toThrow("simulated kill");
		expect(await Bun.file(path.join(root, "gen-1")).exists()).toBe(false);
		expect(receipts.receipts.size).toBe(0);

		const receipt = await publishExportGeneration({
			root,
			generation: "gen-1",
			publication: "same-filesystem",
			cutoffs: [],
			files: oneExportFile(),
			receipts,
			validate: async directory => {
				expect(await Bun.file(path.join(directory, "sessions/session.jsonl")).text()).toBe("A\n");
			},
		});
		expect(receipt.generation).toBe("gen-1");
		expect(await Bun.file(path.join(root, "gen-1", "manifest.json")).exists()).toBe(true);
	});

	test("repairs a crash after publish and rejects a corrupt published manifest", async () => {
		const root = await temporaryRoot("export-repair");
		const receipts = new MemoryReceiptStore();
		await expect(
			publishExportGeneration({
				root,
				generation: "gen-2",
				publication: "cross-filesystem",
				cutoffs: [],
				files: oneExportFile(),
				receipts,
				validate: async () => undefined,
				fault: async point => {
					if (point === "after-publish") throw new Error("receipt process died");
				},
			}),
		).rejects.toThrow("receipt process died");
		expect(receipts.receipts.size).toBe(0);
		expect(await Bun.file(path.join(root, "gen-2", "COMPLETE.json")).exists()).toBe(true);
		const repaired = await repairPublicationReceipt({
			publishedPath: path.join(root, "gen-2"),
			receipts,
			validate: async () => undefined,
		});
		expect(repaired.generation).toBe("gen-2");

		await Bun.write(path.join(root, "gen-2", "manifest.json"), "{}\n");
		await expect(
			repairPublicationReceipt({
				publishedPath: path.join(root, "gen-2"),
				receipts: new MemoryReceiptStore(),
			}),
		).rejects.toThrow("invalid shape");
	});

	test("disk-full and short-write faults leave no published generation", async () => {
		const root = await temporaryRoot("export-io");
		for (const [generation, writeEntry] of [
			[
				"disk-full",
				async () => {
					const error = new Error("no space") as Error & { code: string };
					error.code = "ENOSPC";
					throw error;
				},
			],
			[
				"short-write",
				async (filePath: string) => {
					await Bun.write(filePath, "A");
					return { byteLength: 2, sha256: sha256Bytes("A\n") };
				},
			],
		] as const) {
			await expect(
				publishExportGeneration({
					root,
					generation,
					publication: "same-filesystem",
					cutoffs: [],
					files: oneExportFile(),
					receipts: new MemoryReceiptStore(),
					validate: async () => undefined,
					writeEntry,
				}),
			).rejects.toThrow();
			expect(await Bun.file(path.join(root, generation)).exists()).toBe(false);
		}
	});
});

describe("same-origin no-merge synchronization", () => {
	test("keeps A-B-C and A-B-D as stable siblings across repeated both-direction sync", () => {
		const ab = syncVersion({ origin: "S", version: "v-ab", branch: "base", events: ["A", "B"] });
		const abc = syncVersion({ origin: "S", version: "v-abc", branch: "db-main", parent: "v-ab", events: ["A", "B", "C"] });
		const abd = syncVersion({ origin: "S", version: "v-abd", branch: "json-main", parent: "v-ab", events: ["A", "B", "D"] });
		const first = reconcileSameOrigin({
			targetReplicaId: "db" as ReplicaIdForTest,
			sourceReplicaId: "json" as ReplicaIdForTest,
			target: [ab, abc],
			source: [ab, abd],
			mappings: [],
		});
		const fork = first.actions.find(action => action.versionId === abd.versionId)!;
		expect(fork.kind).toBe("sibling-fork");
		expect(String(fork.forkPointHash)).toBe("B");
		expect(String(fork.parentVersionId)).toBe("v-ab");
		expect(first.counts.deletions).toBe(0);

		const importedAbd = { ...abd, branchId: fork.targetBranchId };
		const repeat = reconcileSameOrigin({
			targetReplicaId: "db" as ReplicaIdForTest,
			sourceReplicaId: "json" as ReplicaIdForTest,
			target: [ab, abc, importedAbd],
			source: [ab, abd],
			mappings: first.mappings,
		});
		expect(repeat.actions.find(action => action.versionId === abd.versionId)?.kind).toBe("no-op");
		expect(repeat.counts.siblingForks).toBe(0);
		expect(repeat.mappings).toEqual([]);

		const reverse = reconcileSameOrigin({
			targetReplicaId: "json" as ReplicaIdForTest,
			sourceReplicaId: "db" as ReplicaIdForTest,
			target: [ab, abd],
			source: [ab, abc, importedAbd],
			mappings: [],
		});
		expect(reverse.actions.find(action => action.versionId === abc.versionId)?.kind).toBe("sibling-fork");
		expect(reverse.counts.deletions).toBe(0);
	});

	test("preserves metadata-only versions, explicit equal-content branches, and target items absent from source", () => {
		const base = syncVersion({ origin: "S", version: "v1", branch: "left", events: ["A"], metadata: "m1" });
		const metadata = syncVersion({ origin: "S", version: "v2", branch: "right", parent: "v1", events: ["A"], metadata: "m2" });
		const plan = reconcileSameOrigin({
			targetReplicaId: "target" as ReplicaIdForTest,
			sourceReplicaId: "source" as ReplicaIdForTest,
			target: [base],
			source: [metadata],
			mappings: [],
		});
		expect(plan.actions[0]?.kind).toBe("metadata-version");
		expect(plan.counts.deletions).toBe(0);

		const mapping = plan.mappings[0] as ReplicaBranchMapping;
		const equalVersion = { ...base, branchId: "another" as SyncVersionSnapshot["branchId"] };
		const attach = reconcileSameOrigin({
			targetReplicaId: "target" as ReplicaIdForTest,
			sourceReplicaId: "source" as ReplicaIdForTest,
			target: [base],
			source: [equalVersion],
			mappings: [mapping],
		});
		expect(attach.actions[0]?.kind).toBe("attach-branch");
	});

	test("does not invent a parent between disjoint same-origin histories", () => {
		const target = syncVersion({ origin: "S", version: "v-a", branch: "target", events: ["A"] });
		const source = syncVersion({ origin: "S", version: "v-x", branch: "source", events: ["X"] });
		const plan = reconcileSameOrigin({
			targetReplicaId: "target" as ReplicaIdForTest,
			sourceReplicaId: "source" as ReplicaIdForTest,
			target: [target],
			source: [source],
			mappings: [],
		});
		expect(plan.actions[0]?.kind).toBe("sibling-fork");
		expect(plan.actions[0]?.parentVersionId).toBeNull();
		expect(plan.actions[0]?.forkPointHash).toBeNull();
	});

	test("persists per-replica branch mappings before applying a sync plan", async () => {
		const root = await temporaryRoot("replica-mapping");
		const storePath = path.join(root, "mappings.json");
		const source = syncVersion({ origin: "S", version: "v1", branch: "source-main", events: ["A"] });
		const store = await ReplicaBranchMappingStore.open(storePath);
		const first = await reconcileAndPersistSameOrigin({
			mappingStore: store,
			targetReplicaId: "target" as ReplicaIdForTest,
			sourceReplicaId: "source" as ReplicaIdForTest,
			target: [],
			source: [source],
		});
		const reopened = await ReplicaBranchMappingStore.open(storePath);
		const repeated = await reconcileAndPersistSameOrigin({
			mappingStore: reopened,
			targetReplicaId: "target" as ReplicaIdForTest,
			sourceReplicaId: "source" as ReplicaIdForTest,
			target: [],
			source: [source],
		});
		expect(reopened.mappings).toHaveLength(1);
		expect(repeated.actions[0]?.targetBranchId).toBe(first.actions[0]?.targetBranchId);
		expect(repeated.mappings).toEqual([]);
	});
});

describe("recovery and experimental fencing", () => {
	test("JSONL standalone recovery succeeds without touching a native database factory", async () => {
		const root = await temporaryRoot("jsonl-recovery");
		const receipts = new MemoryReceiptStore();
		let nativeOpened = false;
		const request = {
			mode: "jsonl" as const,
			schemaVersion: 1 as const,
			destinationRoot: root,
			generation: "jsonl-safe",
			receipts,
			files: oneExportFile("{\"type\":\"session\"}\n"),
			cutoffs: [],
			validate: async (directory: string) => {
				const line = await Bun.file(path.join(directory, "sessions/session.jsonl")).text();
				expect(JSON.parse(line)).toEqual({ type: "session" });
			},
			get openDatabase() {
				nativeOpened = true;
				throw new Error("native library unavailable");
			},
		};
		const receipt = await runStandaloneRecovery(request);
		expect(receipt.generation).toBe("jsonl-safe");
		expect(nativeOpened).toBe(false);
	});

	test("creates verified backups, salvages only a copy, and gates schema upgrades", async () => {
		const root = await temporaryRoot("backup");
		const source = path.join(root, "source.wcdb.sqlite");
		await Bun.write(source, "committed database bytes");
		const backup = await createVerifiedBackup({
			root: path.join(root, "backups"),
			backupId: "backup-1",
			adapter: {
				async createSnapshot(destinationFile) {
					await fs.copyFile(source, destinationFile);
					return { schemaVersion: 1, engine: "wcdb-test-copy", sourceGeneration: "7", acknowledgedHeads: { S: "C" } };
				},
				async verifySnapshot(snapshotFile) {
					return { ok: (await Bun.file(snapshotFile).text()) === "committed database bytes", issues: [] };
				},
			},
		});
		expect(backup.byteLength).toBe(24);
		const gate = createSchemaRollbackGate({ sourceSchemaVersion: 1, targetSchemaVersion: 2, backup });
		expect(() => assertSchemaRollbackGate(gate, { sourceSchemaVersion: 1, targetSchemaVersion: 2, backup })).not.toThrow();
		expect(() =>
			assertSchemaRollbackGate({ ...gate, backupSha256: "tampered" }, { sourceSchemaVersion: 1, targetSchemaVersion: 2, backup }),
		).toThrow("rollback snapshot gate");

		let adapterInput = "";
		const report = await salvageOnCopy({
			sourcePath: source,
			workspaceRoot: path.join(root, "salvage"),
			adapter: {
				async salvage(copiedSource, recoveredDestination) {
					adapterInput = copiedSource;
					await fs.copyFile(copiedSource, recoveredDestination);
					return { recoveredRecords: 3, lostRecords: 0, warnings: [] };
				},
				async verify(recoveredDestination) {
					return { ok: (await Bun.file(recoveredDestination).text()) === "committed database bytes", issues: [] };
				},
			},
		});
		expect(adapterInput).not.toBe(source);
		expect(report.verified).toBe(true);
		expect(report.lostRecords).toBe(0);
		expect(await Bun.file(source).text()).toBe("committed database bytes");
	});

	test("failed experimental mode switch preserves the prior mode and fences stale writers", async () => {
		const root = await temporaryRoot("fencing");
		const transition = await ExperimentalModeTransition.create({
			directory: root,
			transitionId: "switch-1",
			profileId: "profile",
			activeMode: "jsonl",
			activeGeneration: 4,
			targetMode: "db",
		});
		const steps: string[] = [];
		let transferJobId = "";
		const state = await transition.execute({
			async prepare() {
				steps.push("prepare");
				return { allProcessesAcknowledgedOrStopped: true };
			},
			async drain() {
				steps.push("drain");
			},
			async transfer(_token, recoverableJobId) {
				steps.push("transfer");
				transferJobId = recoverableJobId;
				return { recoverableJobId };
			},
			async verify() {
				steps.push("verify");
			},
			async reopen() {
				steps.push("reopen");
			},
		});
		expect(steps).toEqual(["prepare", "drain", "transfer", "verify"]);
		expect(state.phase).toBe("failed");
		expect(state.activeMode).toBe("jsonl");
		expect(state.recoverableJobId).toBe(transferJobId);
		expect(state.error).toContain("config commit is prohibited");
		expect(() =>
			assertWriteFence({ processGeneration: 4, activeGeneration: 4, transition: transition.state.token }),
		).toThrow("draining writers");
		expect(() => assertWriteFence({ processGeneration: 3, activeGeneration: 4 })).toThrow("Stale storage writer");
	});

	test("reopens at the durable phase and reuses the reserved transfer job", async () => {
		const root = await temporaryRoot("fencing-resume");
		const transition = await ExperimentalModeTransition.create({
			directory: root,
			transitionId: "switch-resume",
			profileId: "profile",
			activeMode: "jsonl",
			activeGeneration: 8,
			targetMode: "db",
		});
		const steps: string[] = [];
		const transferJobs: string[] = [];
		await expect(
			transition.execute({
				async prepare() {
					steps.push("prepare");
					return { allProcessesAcknowledgedOrStopped: true };
				},
				async drain() {
					steps.push("drain");
				},
				async transfer(_token, recoverableJobId) {
					steps.push("transfer");
					transferJobs.push(recoverableJobId);
					throw new ModeTransitionInterruptedError("simulated process death");
				},
				async verify() {
					throw new Error("verify must not run before transfer recovery");
				},
				async reopen() {
					throw new Error("reopen is capability-disabled");
				},
			}),
		).rejects.toThrow("simulated process death");
		expect(transition.state.phase).toBe("transferring");

		const reopened = await ExperimentalModeTransition.open(root);
		const state = await reopened.execute({
			async prepare() {
				steps.push("replayed-prepare");
				return { allProcessesAcknowledgedOrStopped: true };
			},
			async drain() {
				steps.push("replayed-drain");
			},
			async transfer(_token, recoverableJobId) {
				steps.push("transfer");
				transferJobs.push(recoverableJobId);
				return { recoverableJobId };
			},
			async verify() {
				steps.push("verify");
			},
			async reopen() {
				steps.push("reopen");
			},
		});
		expect(steps).toEqual(["prepare", "drain", "transfer", "transfer", "verify"]);
		expect(transferJobs[1]).toBe(transferJobs[0]);
		expect(state.phase).toBe("failed");
		expect(state.activeMode).toBe("jsonl");
	});
});
