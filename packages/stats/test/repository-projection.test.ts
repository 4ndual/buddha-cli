import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { streamRepositoryStats } from "../src/repository";
import type { SessionEntry } from "../src/types";

interface Header {
	originId: string;
	branchId: string;
	versionId: string;
	metadata: { cwd: string };
}

class StatsRepositoryFake {
	readonly mode = "db" as const;
	readonly headers: Header[] = [
		{ originId: "origin-a", branchId: "branch-a", versionId: "version-a", metadata: { cwd: "/work/a" } },
		{ originId: "origin-b", branchId: "branch-b", versionId: "version-b", metadata: { cwd: "/work/b" } },
	];
	readonly events = new Map<string, SessionEntry[]>([
		[
			"branch-a",
			[
				{
					type: "message",
					id: "user-a",
					parentId: null,
					timestamp: "2026-09-15T10:00:00.000Z",
					message: { role: "user", content: "please inspect this" },
				},
				{
					type: "message",
					id: "assistant-a",
					parentId: "user-a",
					timestamp: "2026-09-15T10:00:01.000Z",
					message: {
						role: "assistant",
						content: [],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-test",
						usage: {
							input: 3,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 5,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.parse("2026-09-15T10:00:01.000Z"),
					},
				},
			],
		],
		[
			"branch-b",
			[
				{
					type: "model_usage",
					id: "usage-b",
					parentId: null,
					timestamp: "2026-09-15T11:00:00.000Z",
					purpose: "title",
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
				},
			],
		],
	]);
	listCursors: Array<number | undefined> = [];
	readCursors: Array<number | undefined> = [];

	async listSessions(query: { cursor?: number; limit?: number } = {}) {
		this.listCursors.push(query.cursor);
		const offset = query.cursor ?? 0;
		const items = this.headers.slice(offset, offset + 1);
		return { items, nextCursor: offset + 1 < this.headers.length ? offset + 1 : undefined };
	}

	async readEvents(query: { branchId: string; versionId?: string; cursor?: number; limit?: number }) {
		this.readCursors.push(query.cursor);
		const rows = this.events.get(query.branchId) ?? [];
		const offset = query.cursor ?? 0;
		const entries = rows.slice(offset, offset + 1);
		return {
			items: entries.map(entry => ({ entry })),
			nextCursor: offset + 1 < rows.length ? offset + 1 : undefined,
		};
	}
}

afterEach(() => vi.restoreAllMocks());

describe("repository stats projection", () => {
	it("streams logical identities across multiple keyset pages without touching JSONL", async () => {
		vi.spyOn(fs, "stat").mockImplementation(() => {
			throw new Error("JSONL stat forbidden");
		});
		vi.spyOn(fs, "readdir").mockImplementation(() => {
			throw new Error("JSONL scan forbidden");
		});
		const repository = new StatsRepositoryFake();
		const pages = [];
		for await (const page of streamRepositoryStats(repository, { sessionPageSize: 1, eventPageSize: 1 })) {
			pages.push(page);
		}

		expect(pages).toHaveLength(3);
		expect(pages.flatMap(page => page.batch.stats).map(row => [row.session.branchId, row.session.versionId])).toEqual([
			["branch-a", "version-a"],
			["branch-b", "version-b"],
		]);
		expect(pages.flatMap(page => page.batch.userStats).map(row => row.session.originId)).toEqual(["origin-a"]);
		expect(repository.listCursors).toEqual([undefined, 1]);
		expect(repository.readCursors).toContain(1);
	});
});
