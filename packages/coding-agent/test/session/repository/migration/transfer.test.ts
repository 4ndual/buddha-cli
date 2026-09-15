import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	LOGICAL_BUNDLE_FORMAT,
	canonicalJson,
	consumeBoundedArchiveStream,
	consumeSessionArchiveItemStream,
	publishLogicalBundle,
	sha256,
	verifyPublishedBundle,
	type JsonValue,
	type LogicalBranch,
	type LogicalBundle,
	type LogicalEvent,
	type LogicalVersion,
} from "../../../../src/session/repository/migration/bundle";
import { exportLogicalBundle } from "../../../../src/session/repository/migration/export";
import {
	assertGenerationToken,
	createGenerationFence,
	prepareDrainVerifyTransition,
} from "../../../../src/session/repository/migration/fencing";
import type {
	ImportBatchResult,
	ImportVersionPlan,
	LogicalImportTarget,
} from "../../../../src/session/repository/migration/import";
import {
	createMigrationJob,
	readMigrationJob,
	runMigrationJob,
	type JobItem,
} from "../../../../src/session/repository/migration/jobs";
import { recoverPublishedExport } from "../../../../src/session/repository/migration/recovery";
import { synchronizeLogicalReplicas } from "../../../../src/session/repository/migration/sync";

const ownedRoot = process.env.TURSO_TRANSFER_TEST_ROOT ?? "/home/andual/Projects/.turso-migration-owned/transfer/staging";
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	await mkdir(ownedRoot, { recursive: true });
	const path = await mkdtemp(join(ownedRoot, "transfer-test-"));
	temporaryRoots.push(path);
	return path;
}

class MemoryReplica implements LogicalImportTarget {
	readonly mappings = new Map<string, string>();
	readonly receipts = new Map<string, ImportBatchResult>();
	private bundle: LogicalBundle;

	constructor(readonly replicaId: string, initial: LogicalBundle) {
		this.bundle = structuredClone(initial);
		for (const branch of this.bundle.branches) {
			this.mappings.set(`${replicaId}\0${branch.branch_id}`, branch.branch_id);
			for (const alias of branch.replica_aliases ?? []) {
				this.mappings.set(`${alias.replica_id}\0${alias.branch_id}`, branch.branch_id);
			}
		}
	}

	async readLogicalSnapshot(): Promise<LogicalBundle> {
		return structuredClone(this.bundle);
	}

	async lookupBranchMapping(sourceReplicaId: string, sourceBranchId: string): Promise<string | null> {
		return this.mappings.get(`${sourceReplicaId}\0${sourceBranchId}`) ?? null;
	}

	async applyImportBatch(plans: readonly ImportVersionPlan[], idempotencyKey: string): Promise<ImportBatchResult> {
		const prior = this.receipts.get(idempotencyKey);
		if (prior) return prior;
		const next = structuredClone(this.bundle);
		const events = new Map(next.events.map((event) => [event.event_hash, event]));
		const versions = new Map(next.versions.map((version) => [version.version_id, version]));
		const branches = new Map(next.branches.map((branch) => [branch.branch_id, branch]));
		const origins = new Set(next.origins);
		for (const plan of plans) {
			const mappingKey = `${plan.source_replica_id}\0${plan.source_branch_id}`;
			const existingVersion = versions.get(plan.version.version_id);
			if (existingVersion) {
				const current = branches.get(plan.target_branch_id);
				if (!current) {
					branches.set(plan.target_branch_id, {
						branch_id: plan.target_branch_id,
						origin_id: existingVersion.origin_id,
						parent_branch_id: null,
						fork_point_hash: existingVersion.fork_point_hash,
						head_hash: existingVersion.head_hash,
						head_version_id: existingVersion.version_id,
						replica_aliases: plan.branch_aliases,
					});
				}
				for (const alias of plan.branch_aliases) {
					this.mappings.set(`${alias.replica_id}\0${alias.branch_id}`, plan.target_branch_id);
				}
				continue;
			}
			const current = branches.get(plan.target_branch_id);
			if ((current?.head_hash ?? null) !== plan.expected_head_hash) throw new Error("stale expected head");
			for (const event of plan.events) {
				const existing = events.get(event.event_hash);
				if (existing && canonicalJson(existing as unknown as JsonValue) !== canonicalJson(event as unknown as JsonValue)) {
					throw new Error("hash collision");
				}
				events.set(event.event_hash, event);
			}
			origins.add(plan.version.origin_id);
			const storedVersion = { ...plan.version, branch_id: plan.target_branch_id };
			versions.set(storedVersion.version_id, storedVersion);
			branches.set(plan.target_branch_id, {
				branch_id: plan.target_branch_id,
				origin_id: plan.version.origin_id,
				parent_branch_id: plan.relationship === "divergence" || plan.relationship === "historical" ? current?.branch_id ?? null : null,
				fork_point_hash: plan.version.fork_point_hash,
				head_hash: plan.version.head_hash,
				head_version_id: plan.version.version_id,
				replica_aliases: plan.branch_aliases,
			});
			for (const alias of plan.branch_aliases) {
				this.mappings.set(`${alias.replica_id}\0${alias.branch_id}`, plan.target_branch_id);
			}
		}
		next.origins = [...origins].sort();
		next.events = [...events.values()];
		next.versions = [...versions.values()];
		next.branches = [...branches.values()];
		this.bundle = next;
		const result = { receipt_id: idempotencyKey, commit_checksum: sha256(canonicalJson(next)) };
		this.receipts.set(idempotencyKey, result);
		return result;
	}
}

describe("resumable byte-bounded jobs", () => {
	test("advances its durable cursor only with commit receipts and resumes at the next item", async () => {
		const root = await temporaryRoot();
		const journalPath = join(root, "bounded.job.json");
		const items: JobItem<string>[] = ["one", "two", "three"].map((value) => ({
			key: value,
			bytes: 4,
			checksum: sha256(value),
			value,
		}));
		await createMigrationJob(journalPath, {
			jobId: "bounded",
			kind: "import",
			maxBatchBytes: 8,
			items,
		});
		const firstAttempt: string[][] = [];
		await expect(
			runMigrationJob({
				journalPath,
				items,
				executeBatch: async (batch) => {
					const keys = batch.map((item) => item.key);
					firstAttempt.push(keys);
					if (keys[0] === "three") throw new Error("injected transaction stop");
					return { receipt_id: "receipt-one-two", item_keys: keys, commit_checksum: sha256(keys.join(",")) };
				},
			}),
		).rejects.toThrow("injected transaction stop");
		const interrupted = await readMigrationJob(journalPath);
		expect(interrupted.cursor).toBe(2);
		expect(interrupted.receipts).toHaveLength(1);
		const resumedBatches: string[][] = [];
		const resumed = await runMigrationJob({
			journalPath,
			items,
			executeBatch: async (batch) => {
				const keys = batch.map((item) => item.key);
				resumedBatches.push(keys);
				return { receipt_id: "receipt-three", item_keys: keys, commit_checksum: sha256(keys.join(",")) };
			},
		});
		expect(firstAttempt).toEqual([["one", "two"], ["three"]]);
		expect(resumedBatches).toEqual([["three"]]);
		expect(resumed.status).toBe("complete");
		expect(resumed.cursor).toBe(3);
	});
});

describe("bounded archive streaming", () => {
	test("consumes a giant session page-by-page without exceeding record or page limits", async () => {
		const pageWidths: number[] = [];
		const stream = {
			entryCount: 128,
			entryBytes: 128 * 1024,
			payloadRefCount: 0,
			async *openEntryPages() {
				for (let page = 0; page < 32; page += 1) {
					yield {
						items: Array.from({ length: 4 }, () => ({ encodedByteLength: 1024, value: "x".repeat(1024) })),
						byteLength: 4 * 1024,
					};
				}
			},
			async *openPayloadPages() {},
		};
		const receipt = await consumeSessionArchiveItemStream(stream, {
			maxEntryBytes: 1024,
			maxTotalEntries: 128,
			maxTotalEntryBytes: 128 * 1024,
			maxEntriesPerPage: 4,
			maxPayloadRefsPerPage: 4,
			maxTotalPayloadRefs: 4,
		}, {
			consumeEntryPage: async (page) => { pageWidths.push(page.items.length); },
			consumePayloadPage: async () => {},
		});
		expect(receipt).toEqual({ entryCount: 128, entryBytes: 128 * 1024, payloadRefs: 0 });
		expect(Math.max(...pageWidths)).toBe(4);
		expect(pageWidths).toHaveLength(32);
	});

	test("rejects an oversized record before handing its page to the consumer", async () => {
		let consumed = false;
		const stream = {
			entryCount: 1,
			entryBytes: 2048,
			payloadRefCount: 0,
			async *openEntryPages() {
				yield { items: ["x".repeat(2048)], byteLength: 2048 };
			},
			async *openPayloadPages() {},
		};
		await expect(consumeBoundedArchiveStream(stream, {
			maxEntryBytes: 1024,
			maxTotalEntries: 1,
			maxTotalEntryBytes: 4096,
			maxEntriesPerPage: 4,
			maxPayloadRefsPerPage: 4,
			maxTotalPayloadRefs: 4,
		}, {
			measureEntry: (entry) => Buffer.byteLength(entry),
			consumeEntryPage: async () => { consumed = true; },
			consumePayloadPage: async () => {},
		})).rejects.toThrow("record byte limit");
		expect(consumed).toBe(false);
	});
});

describe("logical bundle publication and recovery", () => {
	test("publishes only complete verified manifests and leaves faulted output unpublished", async () => {
		const root = await temporaryRoot();
		const bundle = fixture("replica-a", "C");
		const partialDestination = join(root, "partial");
		await expect(
			publishLogicalBundle(bundle, {
				allowedRoot: root,
				destination: partialDestination,
				generationId: "faulted",
				beforePublish: () => {
					throw new Error("injected stop");
				},
			}),
		).rejects.toThrow("injected stop");
		await expect(readFile(join(partialDestination, "COMPLETE"), "utf8")).rejects.toThrow();

		const destination = join(root, "published");
		const publication = await publishLogicalBundle(bundle, {
			allowedRoot: root,
			destination,
			generationId: "complete",
		});
		const verified = await verifyPublishedBundle(destination, { allowedRoot: root });
		expect(verified.manifestSha256).toBe(publication.manifestSha256);
		expect(verified.manifest.bundle_sha256).toBe(sha256(canonicalJson(bundle)));
		await writeFile(join(destination, "bundle.json"), "{}", "utf8");
		await expect(verifyPublishedBundle(destination, { allowedRoot: root })).rejects.toThrow("Manifest verification failed");
	});

	test("rejects a bundle path swapped after its directory descriptor is retained", async () => {
		const root = await temporaryRoot();
		const destination = join(root, "race-bundle");
		const moved = join(root, "retained-inode");
		const outside = join(root, "replacement");
		await mkdir(outside);
		await publishLogicalBundle(fixture("race", "C"), {
			allowedRoot: root,
			destination,
			generationId: "race",
		});
		await expect(
			verifyPublishedBundle(destination, {
				allowedRoot: root,
				afterDirectoryOpen: async () => {
					await rename(destination, moved);
					await symlink(outside, destination, "dir");
				},
			}),
		).rejects.toThrow();
	});

	test("rejects a manifest member swapped to a symlink after retaining the bundle descriptor", async () => {
		const root = await temporaryRoot();
		const destination = join(root, "leaf-race-bundle");
		const outside = join(root, "outside-bundle.json");
		const retained = join(destination, "bundle.retained");
		await writeFile(outside, canonicalJson(fixture("outside", "D")));
		await publishLogicalBundle(fixture("leaf-race", "C"), {
			allowedRoot: root,
			destination,
			generationId: "leaf-race",
		});
		await expect(
			verifyPublishedBundle(destination, {
				allowedRoot: root,
				afterDirectoryOpen: async () => {
					await rename(join(destination, "bundle.json"), retained);
					await symlink(outside, join(destination, "bundle.json"));
				},
			}),
		).rejects.toThrow();
	});

	test("recovers publication that became durable before its job receipt", async () => {
		const root = await temporaryRoot();
		const journalPath = join(root, "export.job.json");
		const destination = join(root, "export-generation");
		let inject = true;
		await expect(
			exportLogicalBundle({ readLogicalSnapshot: async () => fixture("replica-a", "C") }, {
				jobId: "export-crash",
				journalPath,
				allowedRoot: root,
				destination,
				generationId: "g1",
				maxBatchBytes: 1024 * 1024,
				afterPublishBeforeReceipt: () => {
					if (inject) {
						inject = false;
						throw new Error("crash before receipt");
					}
				},
			}),
		).rejects.toThrow("crash before receipt");
		const recovered = await recoverPublishedExport({ allowedRoot: root, publishedPath: destination, journalPath });
		expect(recovered.status).toBe("receipt-recovered");
		expect(recovered.job.status).toBe("complete");
		const repeated = await recoverPublishedExport({ allowedRoot: root, publishedPath: destination, journalPath });
		expect(repeated.status).toBe("already-recorded");
	});
});

describe("semantic reconciliation", () => {
	test("repeated both-direction sync preserves true divergence without fork explosion", async () => {
		const root = await temporaryRoot();
		const left = new MemoryReplica("left", fixture("left", "C"));
		const right = new MemoryReplica("right", fixture("right", "D"));
		const first = await synchronizeLogicalReplicas(left, right, {
			jobId: "sync-1",
			leftJournalPath: join(root, "sync-1-lr.json"),
			rightJournalPath: join(root, "sync-1-rl.json"),
			maxBatchBytes: 1024 * 1024,
		});
		expect(first.leftPreview.sibling_forks).toBe(1);
		expect(first.rightPreview.sibling_forks).toBe(1);
		const firstLeft = await left.readLogicalSnapshot();
		const firstRight = await right.readLogicalSnapshot();
		expect(new Set(firstLeft.branches.map((branch) => branch.head_hash))).toEqual(new Set(["C", "D"]));
		expect(new Set(firstRight.branches.map((branch) => branch.head_hash))).toEqual(new Set(["C", "D"]));
		await synchronizeLogicalReplicas(left, right, {
			jobId: "sync-2",
			leftJournalPath: join(root, "sync-2-lr.json"),
			rightJournalPath: join(root, "sync-2-rl.json"),
			maxBatchBytes: 1024 * 1024,
		});
		expect((await left.readLogicalSnapshot()).branches).toHaveLength(firstLeft.branches.length);
		expect((await right.readLogicalSnapshot()).branches).toHaveLength(firstRight.branches.length);
	});

	test("preserves concurrent metadata-only revisions as sibling branches", async () => {
		const root = await temporaryRoot();
		const leftBundle = fixture("left-metadata", "C");
		const rightBundle = fixture("right-metadata", "C");
		leftBundle.versions = leftBundle.versions.map((entry) =>
			entry.version_id === "vC"
				? { ...entry, version_id: "vC-left", metadata_revision_id: "metadata-left", metadata: { title: "left" } }
				: entry,
		);
		leftBundle.branches = [{ ...leftBundle.branches[0], head_version_id: "vC-left" }];
		rightBundle.versions = rightBundle.versions.map((entry) =>
			entry.version_id === "vC"
				? { ...entry, version_id: "vC-right", metadata_revision_id: "metadata-right", metadata: { title: "right" } }
				: entry,
		);
		rightBundle.branches = [{ ...rightBundle.branches[0], head_version_id: "vC-right" }];
		const left = new MemoryReplica("left-metadata", leftBundle);
		const right = new MemoryReplica("right-metadata", rightBundle);
		await synchronizeLogicalReplicas(left, right, {
			jobId: "metadata",
			leftJournalPath: join(root, "metadata-lr.json"),
			rightJournalPath: join(root, "metadata-rl.json"),
			maxBatchBytes: 1024 * 1024,
		});
		for (const replica of [left, right]) {
			const snapshot = await replica.readLogicalSnapshot();
			expect(snapshot.branches).toHaveLength(2);
			expect(new Set(snapshot.versions.map((entry) => entry.version_id))).toEqual(
				new Set(["vA", "vB", "vC-left", "vC-right"]),
			);
		}
	});

	test("retains explicit branch identity when sibling branches share one immutable version", async () => {
		const root = await temporaryRoot();
		const sourceBundle = fixture("explicit-source", "C");
		sourceBundle.branches = [
			...sourceBundle.branches,
			{
				...sourceBundle.branches[0],
				branch_id: "parallel",
				parent_branch_id: "main",
				fork_point_hash: "C",
			},
		];
		const source = new MemoryReplica("explicit-source", sourceBundle);
		const target = new MemoryReplica("explicit-target", fixture("explicit-target", "C"));
		await synchronizeLogicalReplicas(source, target, {
			jobId: "explicit-branch",
			leftJournalPath: join(root, "explicit-lr.json"),
			rightJournalPath: join(root, "explicit-rl.json"),
			maxBatchBytes: 1024 * 1024,
		});
		const result = await target.readLogicalSnapshot();
		expect(new Set(result.branches.map((branch) => branch.branch_id))).toEqual(new Set(["main", "parallel"]));
		expect(result.branches.map((branch) => branch.head_version_id)).toEqual(["vC", "vC"]);
	});
	test("historical truncation creates a sibling and preserves the longer history", async () => {
		const root = await temporaryRoot();
		const target = new MemoryReplica("target", fixture("target", "C"));
		const truncated = fixture("source", "A", true);

		await synchronizeLogicalReplicas(new MemoryReplica("source", truncated), target, {
			jobId: "truncation",
			leftJournalPath: join(root, "trunc-lr.json"),
			rightJournalPath: join(root, "trunc-rl.json"),
			maxBatchBytes: 1024 * 1024,
		});
		const result = await target.readLogicalSnapshot();
		expect(new Set(result.branches.map((branch) => branch.head_hash))).toEqual(new Set(["A", "C"]));
	});
});

describe("generation fencing", () => {
	test("rejects stale writes and completes prepare/drain/verify without switching active mode", async () => {
		const root = await temporaryRoot();
		const fencePath = join(root, "storage.fence.json");
		const original = await createGenerationFence(fencePath, "jsonl");
		const calls: string[] = [];
		const prepared = await prepareDrainVerifyTransition(fencePath, original, "db", {
			prepare: async () => { calls.push("prepare"); },
			drain: async () => { calls.push("drain"); },
			synchronize: async () => { calls.push("synchronize"); },
			verify: async () => { calls.push("verify"); return "verified-head-C"; },
		});
		expect(calls).toEqual(["prepare", "drain", "synchronize", "verify"]);
		expect(prepared.fromMode).toBe("jsonl");
		expect(prepared.targetMode).toBe("db");
		await expect(assertGenerationToken(fencePath, original, "append")).rejects.toThrow("Stale storage generation");
		const state = await assertGenerationToken(fencePath, prepared.token, "flush");
		expect(state.active_mode).toBe("jsonl");
		expect(state.state).toBe("verified");
	});
});

function event(hash: string, parent: string | null): LogicalEvent {
	const payload: JsonValue = { text: hash };
	return {
		event_hash: hash,
		origin_id: "origin-1",
		parent_hash: parent,
		native_entry_id: hash,
		kind: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		payload_hash: sha256(canonicalJson(payload)),
		payload,
	};
}

function version(id: string, head: string, parent: string | null, branchId = "main"): LogicalVersion {
	return {
		version_id: id,
		origin_id: "origin-1",
		branch_id: branchId,
		parent_version_id: parent,
		head_hash: head,
		fork_point_hash: head === "A" ? null : "A",
		metadata_revision_id: `metadata-${id}`,
		metadata: { title: id },
	};
}

function fixture(replicaId: string, head: "A" | "C" | "D", truncation = false): LogicalBundle {
	const events = [event("A", null), event("B", "A")];
	if (head === "C" || truncation) events.push(event("C", "B"));
	if (head === "D") events.push(event("D", "B"));
	const versions: LogicalVersion[] = [version("vA", "A", null), version("vB", "B", "vA")];
	if (head === "C" || truncation) versions.push(version("vC", "C", "vB"));
	if (head === "D") versions.push(version("vD", "D", "vB"));
	let headVersion = head === "A" ? "vA" : `v${head}`;
	if (truncation) {
		versions.push(version("vTruncated", "A", "vC"));
		headVersion = "vTruncated";
	}
	const branch: LogicalBranch = {
		branch_id: "main",
		origin_id: "origin-1",
		parent_branch_id: null,
		fork_point_hash: null,
		head_hash: head,
		head_version_id: headVersion,
	};
	return {
		format: LOGICAL_BUNDLE_FORMAT,
		replica_id: replicaId,
		origins: ["origin-1"],
		events,
		versions,
		branches: [branch],
	};
}
