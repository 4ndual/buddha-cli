import { describe, expect, it } from "bun:test";
import type { CustomEntry, SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	computeBranchIdentity,
	computeEventIdentity,
	computeOriginIdentity,
	computeReplicaIdentity,
	computeSourceAlias,
	computeVersionIdentity,
	JsonlSessionRepository,
	modeGeneration,
	type ArchiveStreamLimits,
	type EventHash,
	type SessionArchiveItem,
	type SessionSemanticMetadata,
	type SourceIdentity,
} from "../../../src/session/repository";

const generation = modeGeneration("round-trip-generation-1");
const timestamp = "2026-09-15T12:00:00.000Z";
const archiveLimits: ArchiveStreamLimits = {
	maxEntryBytes: 1024 * 1024,
	maxEntriesPerPage: 16,
	maxTotalEntries: 1_000,
	maxTotalEntryBytes: 8 * 1024 * 1024,
	maxPayloadRefsPerPage: 16,
	maxTotalPayloadRefs: 1_000,
};

function customEntry(id: string, parentId: string | null, value: string): CustomEntry<{ value: string }> {
	return {
		type: "custom",
		customType: "migration.round-trip.v1",
		id,
		parentId,
		timestamp,
		data: { value },
	};
}

function initialArchiveItem(source: SourceIdentity): SessionArchiveItem {
	const producerReplicaId = computeReplicaIdentity("round-trip-producer").id;
	const origin = computeOriginIdentity(source);
	const alias = computeSourceAlias(source);
	const branch = computeBranchIdentity({ originId: origin.id, replicaId: producerReplicaId, branchKey: alias.id });
	const entries: SessionEntry[] = [customEntry("native-A", null, "A"), customEntry("native-B", "native-A", "B")];
	const eventHashes: EventHash[] = [];
	const hashesByNativeId = new Map<string, EventHash>();
	for (const entry of entries) {
		const { id: _id, parentId: _parentId, ...semanticPayload } = entry;
		const identity = computeEventIdentity({
			originId: origin.id,
			nativeEntryId: entry.id,
			parentEventHash: entry.parentId === null ? null : (hashesByNativeId.get(entry.parentId) ?? null),
			semanticPayload,
		});
		hashesByNativeId.set(entry.id, identity.id);
		eventHashes.push(identity.id);
	}
	const metadata: SessionSemanticMetadata = {
		title: "Round-trip fixture",
		titleSource: "user",
		createdAt: timestamp,
		cwd: "/team-fixture/project",
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
		timestamp,
		cwd: metadata.cwd ?? "",
		title: metadata.title,
		titleSource: metadata.titleSource,
	};
	const records = entries.map(entry => ({ entry, encodedByteLength: Buffer.byteLength(JSON.stringify(entry)) }));
	const entryBytes = records.reduce((total, record) => total + record.encodedByteLength, 0);
	return {
		source,
		sourceAlias: alias.id,
		originId: origin.id,
		branchId: branch.id,
		versionId: version.id,
		parentVersionId: null,
		forkPointHash: null,
		header,
		metadata,
		entryCount: records.length,
		entryBytes,
		payloadRefCount: 0,
		async *openEntryPages() {
			yield { items: records, byteLength: entryBytes };
		},
		async *openPayloadPages() {},
	};
}

async function collectArchive(repository: JsonlSessionRepository, originId: SessionArchiveItem["originId"]) {
	const items: SessionArchiveItem[] = [];
	for await (const item of repository.exportArchive({ originId, limits: archiveLimits })) items.push(item);
	return items.sort((left, right) => left.branchId.localeCompare(right.branchId));
}

async function archiveEntries(item: SessionArchiveItem): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = [];
	for await (const page of item.openEntryPages()) {
		for (const record of page.items) entries.push(record.entry);
	}
	return entries;
}

async function semanticProjection(items: readonly SessionArchiveItem[]): Promise<unknown> {
	return Promise.all(
		items.map(async item => ({
			originId: item.originId,
			sourceAlias: item.sourceAlias,
			branchId: item.branchId,
			versionId: item.versionId,
			parentVersionId: item.parentVersionId,
			forkPointHash: item.forkPointHash,
			metadata: item.metadata,
			entries: await archiveEntries(item),
		})),
	);
}

describe("JSONL repository logical round trip", () => {
	it("preserves origin, aliases, sibling forks, version ancestry, and entry payloads without fork explosion", async () => {
		using sourceRoot = TempDir.createSync("@omp-turso-roundtrip-source-");
		using targetRoot = TempDir.createSync("@omp-turso-roundtrip-target-");
		const source = new JsonlSessionRepository({
			rootDir: sourceRoot.path(),
			replicaId: computeReplicaIdentity("round-trip-source").id,
			modeGeneration: generation,
		});
		const target = new JsonlSessionRepository({
			rootDir: targetRoot.path(),
			replicaId: computeReplicaIdentity("round-trip-target").id,
			modeGeneration: generation,
		});
		const initial = initialArchiveItem({
			sourceNamespace: "omp",
			installationNamespace: "fixture-install",
			nativeId: "duplicate-safe-native-id",
		});
		await source.importArchive([initial], {
			expectedModeGeneration: generation,
			sourceReplicaId: computeReplicaIdentity("round-trip-producer").id,
			limits: archiveLimits,
		});
		const base = await source.getHeader({ branchId: initial.branchId });
		if (!base) throw new Error("round-trip base branch missing");
		const winner = await source.appendWithExpectedHead({
			branchId: initial.branchId,
			expectedHeadHash: base.headEventHash,
			expectedModeGeneration: generation,
			entries: [customEntry("native-C", "native-B", "left continuation")],
		});
		const loser = await source.appendWithExpectedHead({
			branchId: initial.branchId,
			expectedHeadHash: base.headEventHash,
			expectedModeGeneration: generation,
			entries: [customEntry("native-D", "native-B", "right continuation")],
		});
		expect(winner.status).toBe("appended");
		expect(loser.status).toBe("forked");

		const exported = await collectArchive(source, initial.originId);
		expect(exported).toHaveLength(2);
		const firstImport = await target.importArchive(exported, {
			expectedModeGeneration: generation,
			sourceReplicaId: source.replicaId,
			limits: archiveLimits,
		});
		expect(firstImport.deleted).toBe(0);
		const once = await collectArchive(target, initial.originId);
		expect(await semanticProjection(once)).toEqual(await semanticProjection(exported));

		const repeated = await target.importArchive(exported, {
			expectedModeGeneration: generation,
			sourceReplicaId: source.replicaId,
			limits: archiveLimits,
		});
		expect(repeated.duplicates).toBe(2);
		expect(repeated.forked).toBe(0);
		expect(await semanticProjection(await collectArchive(target, initial.originId))).toEqual(
			await semanticProjection(once),
		);
	});

	it("streams binary payload bytes without coercion or chunk overrun", async () => {
		using root = TempDir.createSync("@omp-turso-payload-");
		const repository = new JsonlSessionRepository({
			rootDir: root.path(),
			replicaId: computeReplicaIdentity("payload-target").id,
			modeGeneration: generation,
		});
		const bytes = new Uint8Array([0, 1, 2, 255, 128, 13, 10, 42]);
		const descriptor = await repository.writePayload({
			bytes: [bytes],
			maxBytes: bytes.byteLength,
			maxChunkBytes: bytes.byteLength,
			expectedModeGeneration: generation,
		});
		const chunks: Uint8Array[] = [];
		for await (const chunk of repository.readPayload({ payloadHash: descriptor.payloadHash, chunkBytes: 3 })) {
			chunks.push(chunk);
		}
		const restored = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of chunks) {
			restored.set(chunk, offset);
			offset += chunk.byteLength;
		}

		expect(restored).toEqual(bytes);
		expect(chunks.every(chunk => chunk.byteLength <= 3)).toBe(true);
		expect(descriptor.byteLength).toBe(bytes.byteLength);
	});
});
