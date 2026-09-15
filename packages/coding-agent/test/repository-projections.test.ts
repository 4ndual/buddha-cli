import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { AgentActivityIndex } from "../src/activity";
import { RepositoryHistoryProjection } from "../src/history";
import { collectRepositoryMemoryThreads } from "../src/memories";
import type { SessionEntry } from "../src/session/session-entries";
import type {
	BranchId,
	EventHash,
	KeysetCursor,
	OriginId,
	ReplicaId,
	RepositoryEvent,
	RepositorySessionHeader,
	SessionRepository,
	SourceAlias,
	VersionId,
} from "../src/session/repository/types";
import { RepositorySessionTitleIndex } from "../src/session/title-index";

const branchA = "branch-a" as BranchId;
const branchB = "branch-b" as BranchId;
const versionA = "version-a" as VersionId;
const versionB = "version-b" as VersionId;

function header(branchId: BranchId, versionId: VersionId, title: string, modifiedAt: string): RepositorySessionHeader {
	return {
		originId: `origin-${branchId}` as OriginId,
		branchId,
		versionId,
		sourceAlias: `source-${branchId}` as SourceAlias,
		replicaId: "replica" as ReplicaId,
		headEventHash: null,
		forkPointHash: null,
		parentVersionId: null,
		generation: 1,
		metadata: { title, createdAt: modifiedAt, cwd: `/work/${branchId}` },
		modifiedAt,
	};
}

function event(branchId: BranchId, index: number, entry: SessionEntry): RepositoryEvent {
	return {
		eventHash: `${branchId}-event-${index}` as EventHash,
		originId: `origin-${branchId}` as OriginId,
		parentEventHash: null,
		nativeEntryId: `${branchId}-${index}`,
		generation: index,
		entry,
	};
}

class PagedRepositoryFake {
	readonly mode = "db" as const;
	readonly replicaId = "replica" as ReplicaId;
	readonly headers = [
		header(branchA, versionA, "Alpha", "2026-09-15T10:00:00.000Z"),
		header(branchB, versionB, "Beta", "2026-09-15T09:00:00.000Z"),
	];
	readonly events = new Map<BranchId, RepositoryEvent[]>([
		[
			branchA,
			[
				event(branchA, 1, {
					type: "message",
					id: "a-user",
					parentId: null,
					timestamp: "2026-09-15T09:59:00.000Z",
					message: { role: "user", content: "alpha prompt", timestamp: Date.parse("2026-09-15T09:59:00.000Z") },
				}),
				event(branchA, 2, {
					type: "message",
					id: "a-assistant",
					parentId: "a-user",
					timestamp: "2026-09-15T10:00:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "alpha answer" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-test",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.parse("2026-09-15T10:00:00.000Z"),
					},
				}),
			],
		],
		[
			branchB,
			[
				event(branchB, 1, {
					type: "message",
					id: "b-user",
					parentId: null,
					timestamp: "2026-09-15T08:59:00.000Z",
					message: { role: "user", content: "beta prompt", timestamp: Date.parse("2026-09-15T08:59:00.000Z") },
				}),
			],
		],
	]);
	listCalls: Array<{ cursor?: KeysetCursor; limit?: number }> = [];
	readCalls: Array<{ branchId: BranchId; cursor?: KeysetCursor; limit?: number }> = [];

	async listSessions(query: { cursor?: KeysetCursor; limit?: number } = {}) {
		this.listCalls.push(query);
		const offset = query.cursor ? Number(query.cursor) : 0;
		const limit = Math.min(query.limit ?? 100, 1);
		const items = this.headers.slice(offset, offset + limit);
		const next = offset + items.length;
		return { items, nextCursor: next < this.headers.length ? (String(next) as KeysetCursor) : undefined };
	}

	async readEvents(query: { branchId: BranchId; cursor?: KeysetCursor; limit?: number }) {
		this.readCalls.push(query);
		const rows = this.events.get(query.branchId) ?? [];
		const offset = query.cursor ? Number(query.cursor) : 0;
		const limit = Math.min(query.limit ?? 100, 1);
		const items = rows.slice(offset, offset + limit);
		const next = offset + items.length;
		return { items, nextCursor: next < rows.length ? (String(next) as KeysetCursor) : undefined };
	}

	async getHeader(request: { branchId: BranchId }) {
		return this.headers.find(value => value.branchId === request.branchId);
	}

	async search(query: { text: string; limit?: number; cursor?: KeysetCursor }) {
		const offset = query.cursor ? Number(query.cursor) : 0;
		const headerValue = this.headers[offset];
		return {
			items: headerValue ? [{ header: headerValue, snippet: `${query.text} result` }] : [],
			nextCursor: offset + 1 < this.headers.length ? (String(offset + 1) as KeysetCursor) : undefined,
		};
	}
}

const forbidden = () => {
	throw new Error("JSONL filesystem access is forbidden in repository mode");
};

afterEach(() => vi.restoreAllMocks());

describe("repository-backed projections", () => {
	it("paginates memories, titles, history, and activity without JSONL filesystem access", async () => {
		vi.spyOn(fsPromises, "readdir").mockImplementation(forbidden);
		vi.spyOn(fsPromises, "stat").mockImplementation(forbidden);
		vi.spyOn(fs, "mkdirSync").mockImplementation(forbidden);
		const fake = new PagedRepositoryFake();
		// This fake intentionally implements only the read surface exercised by projections.
		const repository = fake as unknown as SessionRepository;

		const memories = await collectRepositoryMemoryThreads(repository, { limit: 2, pageSize: 1 });
		expect(memories.map(value => [value.branchId, value.versionId, value.rolloutPath])).toEqual([
			[branchA, versionA, undefined],
			[branchB, versionB, undefined],
		]);

		const titles = await new RepositorySessionTitleIndex({ repository }).list({ limit: 2, pageSize: 1 });
		expect(titles.map(value => value.title)).toEqual(["Alpha", "Beta"]);

		const history = new RepositoryHistoryProjection({ repository });
		const recent = await history.recent({ limit: 2, sessionPageSize: 1, eventPageSize: 1 });
		expect(recent.map(value => [value.branchId, value.versionId, value.prompt])).toEqual([
			[branchA, versionA, "alpha prompt"],
			[branchB, versionB, "beta prompt"],
		]);
		const firstSearchPage = await history.search({ text: "prompt", limit: 1 });
		const secondSearchPage = await history.search({
			text: "prompt",
			limit: 1,
			cursor: firstSearchPage.nextCursor,
		});
		expect([...firstSearchPage.items, ...secondSearchPage.items].map(value => value.versionId)).toEqual([
			versionA,
			versionB,
		]);

		const activity = new AgentActivityIndex({
			repository,
			locateAgent: () => ({ branchId: branchA, versionId: versionA }),
			pageSize: 1,
		});
		await activity.sync("AlphaAgent", "/forbidden/session.jsonl");
		expect(activity.query().map(value => value.summary)).toEqual(["alpha answer"]);
		expect(fake.listCalls.some(call => call.cursor !== undefined)).toBe(true);
		expect(fake.readCalls.some(call => call.cursor !== undefined)).toBe(true);
	});
});
