import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEventReference, SessionSwitchEvent } from "../../../src/extensibility/shared-events";
import type { RpcSessionReference, RpcSessionState } from "../../../src/modes/rpc/rpc-types";
import { AcpAgent } from "../../../src/modes/acp/acp-agent";
import {
	computeReplicaIdentity,
	JsonlSessionRepository,
	modeGeneration,
	type SessionRepository,
} from "../../../src/session/repository";
import { resolveRepositorySession } from "../../../src/session/session-listing";
import { SessionManager } from "../../../src/session/session-manager";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(name: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
	roots.push(root);
	return root;
}

function repository(rootDir: string): JsonlSessionRepository {
	return new JsonlSessionRepository({
		rootDir,
		replicaId: computeReplicaIdentity("manager-cutover-tests").id,
		modeGeneration: modeGeneration("manager-cutover-generation"),
	});
}

function dbFacade(source: SessionRepository): SessionRepository {
	return new Proxy(source, {
		get(target, property, receiver) {
			if (property === "mode") return "db";
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("repository-backed SessionManager", () => {
	test("JSONL repository preserves append, title, fork, resume, context, and keyset pages", async () => {
		const root = temporaryRoot("omp-manager-jsonl-");
		const repo = repository(root);
		const manager = await SessionManager.createInRepository(repo, "/workspace/alpha");
		manager.appendMessage({ role: "user", content: "repository context", timestamp: 1 });
		await manager.setSessionName("Repository title", "user");
		await manager.flush();

		const original = manager.getSessionLocator();
		expect(original).toBeDefined();
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getSessionDir()).toBeUndefined();

		const second = await SessionManager.createInRepository(repo, "/workspace/beta");
		second.appendMessage({ role: "user", content: "second session", timestamp: 2 });
		await second.flush();
		const firstPage = await SessionManager.listRepositoryPage(repo, { limit: 1 });
		expect(firstPage.items).toHaveLength(1);
		expect(firstPage.nextCursor).toBeDefined();
		const secondPage = await SessionManager.listRepositoryPage(repo, { limit: 1, cursor: firstPage.nextCursor });
		expect(secondPage.items).toHaveLength(1);

		const resolved = await resolveRepositorySession(repo, original!.branchId.slice(0, 12), { pageSize: 1 });
		expect(resolved?.locator.branchId).toBe(original!.branchId);

		const live = await SessionManager.createInRepository(repo, "/workspace/live");
		await live.setRepositorySession(repo, original!, { maxEntries: 10, pageSize: 1 });
		expect(live.getSessionLocator()).toEqual(original);
		expect(live.buildSessionContext().messages[0]).toMatchObject({
			role: "user",
			content: "repository context",
		});
		expect(resolved?.path).toBeUndefined();

		const fork = await manager.fork();
		expect(fork?.current.locator?.branchId).not.toBe(original!.branchId);
		const resumed = await SessionManager.openRepository(repo, fork!.current.locator!, {
			maxEntries: 10,
			pageSize: 1,
		});
		expect(resumed.getSessionName()).toBe("Repository title");
		expect(resumed.getEntries().map(entry => entry.type)).toEqual(["message", "title_change"]);
		expect(resumed.buildSessionContext().messages[0]).toMatchObject({ role: "user", content: "repository context" });
		await repo.close();
	});

	test("ACP repository listing uses opaque keyset cursors", async () => {
		const root = temporaryRoot("omp-manager-acp-");
		const source = repository(root);
		const first = await SessionManager.createInRepository(source, "/workspace/acp");
		first.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await first.flush();
		const second = await SessionManager.createInRepository(source, "/workspace/acp");
		second.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await second.flush();

		const repo = dbFacade(source);
		const agent = new AcpAgent(
			{} as never,
			(async () => {
				throw new Error("not used");
			}) as never,
			{ sessionManager: { getRepository: () => repo } } as never,
		);
		const page = await agent.listSessions({});
		expect(page.sessions).toHaveLength(2);
		expect(page.sessions.map(session => session.sessionId).sort()).toEqual(
			[first.getSessionLocator()!.branchId, second.getSessionLocator()!.branchId].sort(),
		);
		expect(page.nextCursor).toBeUndefined();
		await source.close();
	});

	test("DB logical results expose no path and ordinary manager operations leave sentinel tree untouched", async () => {
		const backingRoot = temporaryRoot("omp-manager-db-backing-");
		const sentinelRoot = temporaryRoot("omp-manager-db-sentinel-");
		const sentinel = path.join(sentinelRoot, "do-not-touch.jsonl");
		fs.writeFileSync(sentinel, "sentinel");
		const repo = dbFacade(repository(backingRoot));

		const manager = await SessionManager.createInRepository(repo, "/workspace/db");
		manager.appendMessage({ role: "user", content: "db only", timestamp: 3 });
		await manager.setSessionName("DB title", "user");
		await manager.flush();
		const page = await SessionManager.listRepositoryPage(repo, { limit: 1 });

		expect(page.items[0]?.mode).toBe("db");
		expect(page.items[0]?.path).toBeUndefined();
		const locator = manager.getSessionLocator();
		if (!locator) throw new Error("Expected repository session locator");
		expect(manager.getSessionReference()).toEqual({ locator });
		expect(fs.readFileSync(sentinel, "utf8")).toBe("sentinel");
		expect(fs.readdirSync(sentinelRoot)).toEqual(["do-not-touch.jsonl"]);
		await repo.close();
	});

	test("extension and RPC public references carry locators without fake paths", () => {
		const locator = {
			branchId: "branch-public" as never,
			versionId: "version-public" as never,
		};
		const reference = { locator } satisfies SessionEventReference;
		const event = { type: "session_switch", reason: "resume", previousSession: reference } satisfies SessionSwitchEvent;
		const rpcReference = { locator } satisfies RpcSessionReference;
		const state = { session: rpcReference } as Pick<RpcSessionState, "session">;

		expect(event.previousSession).toEqual({ locator });
		expect(state.session).toEqual({ locator });
		expect("path" in reference).toBeFalse();
	});
});
