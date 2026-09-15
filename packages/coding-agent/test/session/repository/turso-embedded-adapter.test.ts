import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { JsonlSessionRepository } from "../../../src/session/repository/jsonl-repository";
import {
	createEmbeddedTursoRuntimeAdapter,
	openEmbeddedTursoRuntimeAdapter,
} from "../../../src/session/repository/turso/embedded-adapter";
import { openLocalTursoDatabase } from "../../../src/session/repository/turso/database";
import { createTursoSessionRepository } from "../../../src/session/repository/turso/repository";
import type { ModeGeneration, ReplicaId, SessionRepository } from "../../../src/session/repository/types";

const replicaId = "replica:embedded-differential" as ReplicaId;
const modeGeneration = "mode-generation:embedded-differential" as ModeGeneration;
const source = {
	sourceNamespace: "omp",
	installationNamespace: "team-fixture",
	nativeId: "embedded-differential",
};
const header = {
	type: "session" as const,
	version: 3,
	id: source.nativeId,
	title: "Embedded differential",
	titleSource: "user" as const,
	timestamp: "2026-09-15T12:00:00.000Z",
	cwd: "/team/fixture",
};
const entry = {
	type: "message" as const,
	id: "message-1",
	parentId: null,
	timestamp: "2026-09-15T12:00:01.000Z",
	message: { role: "user" as const, content: "real embedded payload", timestamp: Date.parse("2026-09-15T12:00:01.000Z") },
};

async function populate(repository: SessionRepository) {
	const created = await repository.createSession({
		expectedModeGeneration: modeGeneration,
		source,
		header,
		callerKey: "embedded-differential",
	});
	const appended = await repository.appendWithExpectedHead({
		expectedModeGeneration: modeGeneration,
		branchId: created.branchId,
		expectedHeadHash: null,
		entries: [entry],
	});
	const titled = await repository.updateTitle({
		expectedModeGeneration: modeGeneration,
		branchId: appended.header.branchId,
		expectedHeadHash: appended.header.headEventHash,
		title: "Renamed differential",
		source: "user",
		updatedAt: "2026-09-15T12:00:02.000Z",
	});
	const forked = await repository.fork({
		expectedModeGeneration: modeGeneration,
		branchId: titled.branchId,
		atEventHash: titled.headEventHash,
		forkKey: "copy",
	});
	const dropped = await repository.drop({
		expectedModeGeneration: modeGeneration,
		locator: { branchId: forked.branchId, versionId: forked.versionId },
		explicit: true,
	});
	const listed = await repository.listSessions({ sourceAlias: titled.sourceAlias, limit: 2 });
	const events = await repository.readEvents({ branchId: titled.branchId, limit: 2 });
	return {
		dropped,
		header: titled,
		listed: listed.items.map(item => ({
			originId: item.originId,
			branchId: item.branchId,
			versionId: item.versionId,
			headEventHash: item.headEventHash,
			metadata: item.metadata,
		})),
		events: events.items.map(item => ({
			eventHash: item.eventHash,
			parentEventHash: item.parentEventHash,
			nativeEntryId: item.nativeEntryId,
			entry: item.entry,
		})),
	};
}

describe("concrete embedded Turso runtime adapter", () => {
	it("rejects production activation before opening a database when native capabilities are disabled", async () => {
		using temp = TempDir.createSync("@omp-turso-adapter-disabled-");
		const databasePath = path.join(temp.path(), "disabled.turso.db");
		await expect(
			openEmbeddedTursoRuntimeAdapter({
				path: databasePath,
				allowedRoot: temp.path(),
				replicaId,
				modeGeneration,
				capabilityReport: { databaseModeEnabled: false },
			}),
		).rejects.toThrow("native capability gates did not pass");
		expect(await Bun.file(databasePath).exists()).toBe(false);
	});

	it("runs the authoritative repository on the real pinned database and matches JSONL semantics", async () => {
		using temp = TempDir.createSync("@omp-turso-adapter-differential-");
		const databasePath = path.join(temp.path(), "sessions.turso.db");
		const jsonlRoot = path.join(temp.path(), "jsonl");
		await fs.mkdir(jsonlRoot, { recursive: true });

		const database = await openLocalTursoDatabase({ path: databasePath, allowedRoot: temp.path() });
		const adapter = await createEmbeddedTursoRuntimeAdapter({ database, replicaId, modeGeneration });
		const embeddedRepository = createTursoSessionRepository({ adapter, defaultPageSize: 2, maxPageSize: 2 });
		const jsonlRepository = new JsonlSessionRepository({ rootDir: jsonlRoot, replicaId, modeGeneration });

		const [embedded, jsonl] = await Promise.all([populate(embeddedRepository), populate(jsonlRepository)]);
		expect(embedded).toEqual(jsonl);
		const payloadBytes = new Uint8Array([0, 1, 2, 3, 254, 255]);
		const descriptor = await embeddedRepository.writePayload({
			expectedModeGeneration: modeGeneration,
			bytes: [payloadBytes.subarray(0, 2), payloadBytes.subarray(2)],
			maxBytes: payloadBytes.byteLength,
			maxChunkBytes: payloadBytes.byteLength,
			mediaType: "application/octet-stream",
		});
		const observedPayload: number[] = [];
		for await (const chunk of embeddedRepository.readPayload({ payloadHash: descriptor.payloadHash, chunkBytes: 2 })) {
			observedPayload.push(...chunk);
		}
		expect(descriptor).toMatchObject({ byteLength: payloadBytes.byteLength, mediaType: "application/octet-stream" });
		expect(observedPayload).toEqual([...payloadBytes]);
		await embeddedRepository.flush({ expectedModeGeneration: modeGeneration });
		await embeddedRepository.close();
		await jsonlRepository.close();

		const reopenedDatabase = await openLocalTursoDatabase({
			path: databasePath,
			allowedRoot: temp.path(),
			fileMustExist: true,
		});
		const reopenedAdapter = await createEmbeddedTursoRuntimeAdapter({
			database: reopenedDatabase,
			replicaId,
			modeGeneration,
		});
		const reopened = createTursoSessionRepository({ adapter: reopenedAdapter, defaultPageSize: 2, maxPageSize: 2 });
		const page = await reopened.listSessions({ limit: 2 });
		expect(page.items).toHaveLength(1);
		const reopenedEntries = (await reopened.readEvents({ branchId: page.items[0]!.branchId, limit: 2 })).items.map(
			item => item.entry,
		);
		expect(reopenedEntries[0]).toEqual(entry);
		expect(reopenedEntries[1]).toMatchObject({
			type: "title_change",
			parentId: entry.id,
			title: "Renamed differential",
			previousTitle: header.title,
			source: "user",
		});
		expect(await reopened.health()).toMatchObject({ mode: "db", status: "ok", writable: true });
		await reopened.close();
	});
});
