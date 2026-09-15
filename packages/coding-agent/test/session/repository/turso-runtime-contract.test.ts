import { describe, expect, it } from "bun:test";
import {
	createTursoSessionRepository,
	type TursoAppendMutation,
	type TursoRuntimeAdapter,
	type TursoRuntimeTransaction,
} from "../../../src/session/repository/turso/repository";
import type {
	BranchId,
	EventHash,
	ModeGeneration,
	RepositorySessionHeader,
	VersionId,
} from "../../../src/session/repository/types";
import type { KeysetPosition } from "../../../src/session/repository/turso/pagination";

const expectedModeGeneration = "mode-generation:8" as ModeGeneration;
const modifiedAt = "2026-09-15T12:00:00.000Z";

function header(
	branchId: string,
	headEventHash: string | null,
	versionId: string,
	options: { forkPointHash?: string | null; parentVersionId?: string | null } = {},
): RepositorySessionHeader {
	return {
		originId: "origin:runtime",
		branchId: branchId as BranchId,
		versionId: versionId as VersionId,
		sourceAlias: "source:runtime",
		replicaId: "replica:runtime",
		headEventHash: headEventHash as EventHash | null,
		forkPointHash: (options.forkPointHash ?? null) as EventHash | null,
		parentVersionId: (options.parentVersionId ?? null) as VersionId | null,
		generation: 1,
		metadata: { title: branchId, createdAt: modifiedAt, cwd: "/team/runtime" },
		modifiedAt,
	};
}

describe("Turso runtime concurrency and pagination", () => {
	it("preserves a CAS loser as a deterministic sibling branch sharing the verified prefix", async () => {
		const branches = new Map<string, RepositorySessionHeader>([
			["main", header("main", "base", "version-base")],
		]);
		const parents = new Map<string, string | null>([["base", null]]);
		const transaction = {
			async assertModeGeneration(candidate: ModeGeneration) {
				if (candidate !== expectedModeGeneration) throw new Error("stale mode generation");
			},
			async getHeader(branchId: BranchId) {
				return branches.get(branchId);
			},
			async isEventReachable(branchId: BranchId, eventHash: EventHash | null) {
				if (eventHash === null) return true;
				let cursor = branches.get(branchId)?.headEventHash ?? null;
				while (cursor !== null) {
					if (cursor === eventHash) return true;
					cursor = (parents.get(cursor) ?? null) as EventHash | null;
				}
				return false;
			},
			async append(mutation: TursoAppendMutation) {
				const last = mutation.request.entries.at(-1);
				if (!last) throw new Error("fixture append requires an entry");
				const newHead = last.id as EventHash;
				const existing = branches.get(mutation.targetBranchId);
				if (existing?.headEventHash === newHead) return { header: existing, changed: false };
				parents.set(newHead, mutation.request.expectedHeadHash);
				const next = header(mutation.targetBranchId, newHead, `version:${last.id}`, {
					forkPointHash: mutation.forkPointHash,
					parentVersionId: existing?.versionId ?? "version-base",
				});
				branches.set(mutation.targetBranchId, next);
				return { header: next, changed: true };
			},
		} as unknown as TursoRuntimeTransaction;
		const adapter = {
			replicaId: "replica:runtime",
			async transaction<T>(work: (candidate: TursoRuntimeTransaction) => Promise<T>) {
				return work(transaction);
			},
		} as unknown as TursoRuntimeAdapter;
		const repository = createTursoSessionRepository({ adapter });
		const append = (id: string) =>
			repository.appendWithExpectedHead({
				expectedModeGeneration,
				branchId: "main" as BranchId,
				expectedHeadHash: "base" as EventHash,
				entries: [
					{
						type: "message",
						id,
						parentId: "base",
						timestamp: modifiedAt,
						message: { role: "user", content: id, timestamp: Date.parse(modifiedAt) },
					},
				],
			});

		const results = await Promise.all([append("left"), append("right")]);
		const winner = results.find(result => result.status === "appended");
		const loser = results.find(result => result.status === "forked");
		expect(winner).toBeDefined();
		expect(loser).toBeDefined();
		expect(branches.get("main")?.headEventHash).toBe(winner?.header.headEventHash);
		expect(loser?.status === "forked" ? loser.conflictedBranchId : undefined).toBe("main");
		expect(loser?.header.forkPointHash).toBe("base");
		expect(parents.get(loser!.header.headEventHash!)).toBe("base");

		const repeated = await append(loser!.header.headEventHash!);
		expect(repeated.status).toBe("forked");
		expect(repeated.header.branchId).toBe(loser?.header.branchId);
		expect(branches.size).toBe(2);
	});

	it("fetches page-size plus one through opaque keyset cursors and never requests the full result set", async () => {
		const rows = Array.from({ length: 100 }, (_, index) => {
			const id = index.toString().padStart(3, "0");
			return {
				value: header(`branch-${id}`, `event-${id}`, `version-${id}`),
				position: { sortKey: id, id: `branch-${id}` } satisfies KeysetPosition,
			};
		});
		const observedLimits: number[] = [];
		const adapter = {
			replicaId: "replica:runtime",
			async listSessions(query: { after?: KeysetPosition; limit: number }) {
				observedLimits.push(query.limit);
				const start = query.after ? rows.findIndex(row => row.position.id === query.after?.id) + 1 : 0;
				return rows.slice(start, start + query.limit);
			},
		} as unknown as TursoRuntimeAdapter;
		const repository = createTursoSessionRepository({ adapter, defaultPageSize: 3, maxPageSize: 3 });

		const first = await repository.listSessions({ limit: 100 });
		const second = await repository.listSessions({ cursor: first.nextCursor, limit: 100 });
		expect(first.items.map(row => row.branchId)).toEqual(["branch-000", "branch-001", "branch-002"]);
		expect(second.items.map(row => row.branchId)).toEqual(["branch-003", "branch-004", "branch-005"]);
		expect(first.nextCursor).toBeDefined();
		expect(second.nextCursor).toBeDefined();
		expect(observedLimits).toEqual([4, 4]);
	});
});
