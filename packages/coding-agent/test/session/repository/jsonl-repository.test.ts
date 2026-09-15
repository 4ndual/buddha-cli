import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomEntry, SessionEntry, SessionHeader } from "../../../src/session/session-entries";
import {
	computeBranchIdentity,
	computeEventIdentity,
	computeOriginIdentity,
	computeReplicaIdentity,
	computeSourceAlias,
	computeVersionIdentity,
	JsonlSessionRepository,
	modeGeneration,
	StaleModeGenerationError,
} from "../../../src/session/repository";
import type {
	EventHash,
	ModeGeneration,
	ReplicaId,
	SessionArchiveItem,
	SessionSemanticMetadata,
	SourceIdentity,
} from "../../../src/session/repository";

const roots: string[] = [];
const generation = modeGeneration("test-generation-1");

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jsonl-repository-"));
	roots.push(root);
	return root;
}

function customEntry(id: string, parentId: string | null, value: string): CustomEntry<{ value: string }> {
	return {
		type: "custom",
		customType: "repository.test",
		id,
		parentId,
		timestamp: `2026-09-15T00:00:0${id.length}.000Z`,
		data: { value },
	};
}

function archiveItem(
	source: SourceIdentity,
	producerReplicaId: ReplicaId,
	entries: readonly SessionEntry[],
	title = `Session ${source.nativeId}`,
): SessionArchiveItem {
	const origin = computeOriginIdentity(source);
	const alias = computeSourceAlias(source);
	const branch = computeBranchIdentity({ originId: origin.id, replicaId: producerReplicaId, branchKey: alias.id });
	const hashesByNativeId = new Map<string, EventHash>();
	const eventHashes: EventHash[] = [];
	for (const entry of entries) {
		const { id: _id, parentId: _parentId, ...semanticPayload } = entry;
		const event = computeEventIdentity({
			originId: origin.id,
			nativeEntryId: entry.id,
			parentEventHash: entry.parentId === null ? null : (hashesByNativeId.get(entry.parentId) ?? null),
			semanticPayload,
		});
		hashesByNativeId.set(entry.id, event.id);
		eventHashes.push(event.id);
	}
	const metadata: SessionSemanticMetadata = {
		title,
		titleSource: "user",
		createdAt: "2026-09-15T00:00:00.000Z",
		cwd: "/workspace",
	};
	const version = computeVersionIdentity({
		originId: origin.id,
		headEventHash: eventHashes.at(-1) ?? null,
		treeEventHashes: eventHashes,
		metadata,
	});
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: source.nativeId,
		timestamp: metadata.createdAt,
		cwd: metadata.cwd ?? "",
		title,
		titleSource: "user",
	};
	return {
		source,
		sourceAlias: alias.id,
		originId: origin.id,
		branchId: branch.id,
		versionId: version.id,
		parentVersionId: null,
		forkPointHash: null,
		header,
		entries,
		metadata,
	};
}

function repository(root: string, replicaKey: string, activeGeneration: ModeGeneration = generation): JsonlSessionRepository {
	return new JsonlSessionRepository({
		rootDir: root,
		replicaId: computeReplicaIdentity(replicaKey).id,
		modeGeneration: activeGeneration,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("JsonlSessionRepository", () => {
	test("imports idempotently and paginates by opaque keyset", async () => {
		const repo = repository(temporaryRoot(), "target");
		const producer = computeReplicaIdentity("producer").id;
		const one = archiveItem(
			{ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "one" },
			producer,
			[customEntry("a", null, "one")],
		);
		const two = archiveItem(
			{ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "two" },
			producer,
			[customEntry("b", null, "two")],
		);
		const first = await repo.importArchive([one, two], { expectedModeGeneration: generation, sourceReplicaId: producer });
		expect(first).toEqual({ imported: 2, extended: 0, forked: 0, duplicates: 0, quarantined: 0, deleted: 0 });
		const repeated = await repo.importArchive([one, two], {
			expectedModeGeneration: generation,
			sourceReplicaId: producer,
		});
		expect(repeated.duplicates).toBe(2);
		expect(repeated.forked).toBe(0);

		const pageOne = await repo.listSessions({ limit: 1 });
		expect(pageOne.items).toHaveLength(1);
		expect(pageOne.nextCursor).toBeDefined();
		const pageTwo = await repo.listSessions({ limit: 1, cursor: pageOne.nextCursor });
		expect(pageTwo.items).toHaveLength(1);
		expect(pageTwo.items[0]?.branchId).not.toBe(pageOne.items[0]?.branchId);
	});

	test("preserves a CAS loser as an idempotent sibling without merging", async () => {
		const repo = repository(temporaryRoot(), "target-cas");
		const producer = computeReplicaIdentity("producer-cas").id;
		const item = archiveItem(
			{ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "cas" },
			producer,
			[customEntry("a", null, "A"), customEntry("b", "a", "B")],
		);
		await repo.importArchive([item], { expectedModeGeneration: generation, sourceReplicaId: producer });
		const base = await repo.getHeader({ branchId: item.branchId });
		expect(base).toBeDefined();
		const expectedHeadHash = base?.headEventHash ?? null;
		const winner = await repo.appendWithExpectedHead({
			branchId: item.branchId,
			expectedHeadHash,
			expectedModeGeneration: generation,
			entries: [customEntry("c", "b", "C")],
		});
		expect(winner.status).toBe("appended");
		const loser = await repo.appendWithExpectedHead({
			branchId: item.branchId,
			expectedHeadHash,
			expectedModeGeneration: generation,
			entries: [customEntry("d", "b", "D")],
		});
		expect(loser.status).toBe("forked");
		if (loser.status !== "forked") throw new Error("Expected sibling fork");
		expect(loser.header.forkPointHash).toBe(expectedHeadHash);

		const siblingEvents = await repo.readEvents({ branchId: loser.header.branchId, limit: 10 });
		expect(siblingEvents.items.map(event => event.nativeEntryId)).toEqual(["a", "b", "d"]);
		expect(siblingEvents.items.some(event => event.nativeEntryId === "c")).toBeFalse();
		const retry = await repo.appendWithExpectedHead({
			branchId: item.branchId,
			expectedHeadHash,
			expectedModeGeneration: generation,
			entries: [customEntry("d", "b", "D")],
		});
		expect(retry.status).toBe("forked");
		expect(retry.header.branchId).toBe(loser.header.branchId);
		expect((await repo.listSessions()).items).toHaveLength(2);
	});

	test("keeps target-only branches during repeated additive sync", async () => {
		const source = repository(temporaryRoot(), "source-sync");
		const target = repository(temporaryRoot(), "target-sync");
		const producer = computeReplicaIdentity("producer-sync").id;
		const shared = archiveItem(
			{ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "shared" },
			producer,
			[customEntry("shared-a", null, "shared")],
		);
		const targetOnly = archiveItem(
			{ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "target-only" },
			producer,
			[customEntry("target-a", null, "target")],
		);
		await source.importArchive([shared], { expectedModeGeneration: generation, sourceReplicaId: producer });
		await target.importArchive([shared, targetOnly], { expectedModeGeneration: generation, sourceReplicaId: producer });
		const once = await target.syncFrom(source, {
			expectedModeGeneration: generation,
			sourceReplicaId: source.replicaId,
		});
		const twice = await target.syncFrom(source, {
			expectedModeGeneration: generation,
			sourceReplicaId: source.replicaId,
		});
		expect(once.deleted).toBe(0);
		expect(twice.deleted).toBe(0);
		expect(twice.duplicates).toBe(1);
		expect((await target.listSessions()).items.map(header => header.branchId).sort()).toEqual(
			[shared.branchId, targetOnly.branchId].sort(),
		);
	});

	test("versions title metadata and rejects stale mode generations", async () => {
		const repo = repository(temporaryRoot(), "title-fence");
		const producer = computeReplicaIdentity("producer-title").id;
		const item = archiveItem(
			{ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "title" },
			producer,
			[customEntry("a", null, "A")],
			"Before",
		);
		await repo.importArchive([item], { expectedModeGeneration: generation, sourceReplicaId: producer });
		const before = await repo.getHeader({ branchId: item.branchId });
		if (!before) throw new Error("Missing imported branch");
		const after = await repo.updateTitle({
			branchId: item.branchId,
			expectedHeadHash: before.headEventHash,
			expectedModeGeneration: generation,
			title: "After",
			source: "user",
			updatedAt: "2026-09-15T01:00:00.000Z",
		});
		expect(after.metadata.title).toBe("After");
		expect(after.versionId).not.toBe(before.versionId);
		await expect(
			repo.flush({ expectedModeGeneration: modeGeneration("stale-generation") }),
		).rejects.toBeInstanceOf(StaleModeGenerationError);
	});

	test("creates fresh branches idempotently and enumerates related resources by keyset", async () => {
		const repo = repository(temporaryRoot(), "create-related");
		const create = async (nativeId: string, callerKey: string) =>
			repo.createSession({
				source: { sourceNamespace: "omp", installationNamespace: "profile", nativeId },
				header: {
					type: "session",
					version: 3,
					id: nativeId,
					timestamp: "2026-09-15T00:00:00.000Z",
					cwd: "/workspace",
				},
				callerKey,
				expectedModeGeneration: generation,
			});
		const parent = await create("new-parent", "parent-key");
		expect((await create("new-parent", "parent-key")).branchId).toBe(parent.branchId);
		const appended = await repo.appendWithExpectedHead({
			branchId: parent.branchId,
			expectedHeadHash: null,
			expectedModeGeneration: generation,
			entries: [customEntry("first", null, "fresh")],
		});
		expect(appended.status).toBe("appended");
		const childA = await create("new-child-a", "child-a-key");
		const childB = await create("new-child-b", "child-b-key");
		for (const [key, target] of [
			["child-a", childA],
			["child-b", childB],
		] as const) {
			await repo.registerRelatedResource({
				locator: {
					owner: { branchId: appended.header.branchId, versionId: appended.header.versionId },
					kind: "child-session",
					key,
				},
				target: { branchId: target.branchId, versionId: target.versionId },
				expectedModeGeneration: generation,
			});
		}
		const first = await repo.listRelatedResources({
			owner: { branchId: appended.header.branchId, versionId: appended.header.versionId },
			kind: "child-session",
			limit: 1,
		});
		expect(first.items.map(binding => binding.locator.key)).toEqual(["child-a"]);
		const second = await repo.listRelatedResources({
			owner: { branchId: appended.header.branchId, versionId: appended.header.versionId },
			kind: "child-session",
			limit: 1,
			cursor: first.nextCursor,
		});
		expect(second.items.map(binding => binding.locator.key)).toEqual(["child-b"]);
	});

	test("module graph remains valid when a DB driver import is forbidden", async () => {
		const entrypoint = path.resolve(import.meta.dir, "../../../src/session/repository/jsonl-repository.ts");
		const result = await Bun.build({
			entrypoints: [entrypoint],
			target: "bun",
			external: ["omp-legacy-pi-modules"],
			plugins: [
				{
					name: "forbid-db-driver",
					setup(build) {
						build.onResolve({ filter: /^@tursodatabase\/database$/ }, () => {
							throw new Error("JSONL module graph attempted to load the DB driver");
						});
					},
				},
			],
		});
		expect(result.success).toBeTrue();
		expect(result.logs).toEqual([]);
	});
});
