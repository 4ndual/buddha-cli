import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IrcBus, type IrcMessage } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { directConversationId, HubInboxService, HubInboxStore, type HubInboxScope } from "../../src/tools/hub/inbox";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map(item => fs.rm(item, { recursive: true, force: true }))));

function fakeSession(outcome: "injected" | "woken" = "injected") {
	const delivered: IrcMessage[] = [];
	const session = {
		deliverIrcMessage: async (message: IrcMessage) => {
			delivered.push(message);
			return outcome;
		},
	} as unknown as AgentSession;
	return { session, delivered };
}

async function fixture(scope: HubInboxScope = { kind: "tree", id: "/repo/.trees/current" }) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hub-real-acceptance-"));
	temporary.push(directory);
	const registry = new AgentRegistry();
	const sessions = new Map<string, ReturnType<typeof fakeSession>>();
	for (const [id, parentId] of [
		["Main", undefined],
		["Child", "Main"],
		["Sibling", "Main"],
		["Grandchild", "Child"],
	] as const) {
		const current = fakeSession();
		sessions.set(id, current);
		registry.register({
			id,
			displayName: id,
			kind: id === "Main" ? "main" : "sub",
			parentId,
			session: current.session,
			status: "idle",
		});
	}
	const lifecycle = new AgentLifecycleManager(registry);
	const bus = new IrcBus(registry, lifecycle);
	const store = new HubInboxStore(directory, scope);
	return {
		directory,
		registry,
		lifecycle,
		bus,
		store,
		service: new HubInboxService(store, registry, bus),
		sessions,
		scope,
	};
}

describe("real OMP Hub acceptance matrix", () => {
	test("01 snapshot exposes stable identities and direct conversations", async () => {
		const { service } = await fixture();
		const snapshot = await service.snapshot("Child");
		expect(snapshot.agents.map(agent => agent.id)).toEqual(["Main", "Child", "Sibling", "Grandchild"]);
		expect(snapshot.conversations.filter(item => item.kind === "direct")).toHaveLength(3);
	});

	test("02 parent sends to child through the real IRC bus", async () => {
		const { service, sessions } = await fixture();
		const entry = await service.sendDirect("Main", "Child", "delegate");
		expect(entry.delivery?.[0]?.outcome).toBe("injected");
		expect(sessions.get("Child")?.delivered[0]?.body).toBe("delegate");
	});

	test("03 child reply keeps replyTo in the same conversation", async () => {
		const { service } = await fixture();
		const request = await service.sendDirect("Main", "Child", "status?");
		const reply = await service.sendDirect("Child", "Main", "done", request.id);
		expect(reply.replyTo).toBe(request.id);
		expect(reply.conversationId).toBe(request.conversationId);
	});

	test("04 cross-conversation replies are rejected", async () => {
		const { service } = await fixture();
		const request = await service.sendDirect("Main", "Child", "status?");
		await expect(service.sendDirect("Sibling", "Main", "wrong thread", request.id)).rejects.toThrow(
			/cross conversations/,
		);
	});

	test("05 siblings can message one another", async () => {
		const { service, sessions } = await fixture();
		await service.sendDirect("Child", "Sibling", "peer review");
		expect(sessions.get("Sibling")?.delivered[0]?.from).toBe("Child");
	});

	test("06 broadcast fans out and persists one timeline row", async () => {
		const { service } = await fixture();
		const entry = await service.broadcast("Main", "heads up");
		expect(entry.delivery).toHaveLength(3);
		expect(await service.history("broadcast:all")).toHaveLength(1);
	});

	test("07 idle delivery records a woken outcome", async () => {
		const current = await fixture();
		const child = fakeSession("woken");
		current.registry.register({
			id: "Wakeable",
			displayName: "Wakeable",
			kind: "sub",
			parentId: "Main",
			session: child.session,
			status: "idle",
		});
		const entry = await current.service.sendDirect("Main", "Wakeable", "wake");
		expect(entry.delivery?.[0]?.outcome).toBe("woken");
	});

	test("08 parked delivery is revived by the real lifecycle manager", async () => {
		const current = await fixture();
		const parked = current.registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		const revived = fakeSession();
		current.lifecycle.adopt("Parked", { idleTtlMs: 0, revive: async () => revived.session }, parked);
		const entry = await current.service.sendDirect("Main", "Parked", "resume");
		expect(entry.delivery?.[0]?.outcome).toBe("revived");
		expect(revived.delivered).toHaveLength(1);
	});

	test("09 async-result metadata survives a store restart", async () => {
		const { service, directory, scope } = await fixture();
		const id = directConversationId("Main", "Child");
		await service.recordAsyncResult(id, "artifact ready", {
			jobId: "job-1",
			status: "succeeded",
			recipientId: "Main",
			outputPath: "/tmp/out",
		});
		const restored = await new HubInboxStore(directory, scope).history(id);
		expect(restored[0]).toMatchObject({ kind: "async_result", metadata: { jobId: "job-1", status: "succeeded" } });
	});

	test("10 lifecycle metadata survives a store restart", async () => {
		const { service, directory, scope } = await fixture();
		const id = directConversationId("Main", "Child");
		await service.recordLifecycle(id, "Child revived", { action: "revive", agentId: "Child", outcome: "revived" });
		const restored = await new HubInboxStore(directory, scope).history(id);
		expect(restored[0]).toMatchObject({ kind: "lifecycle", metadata: { action: "revive", outcome: "revived" } });
	});

	test("11 unread belongs to recipients, not senders", async () => {
		const { service, store, registry } = await fixture();
		await service.sendDirect("Main", "Child", "new work");
		const agents = new Map(service.identities().map(agent => [agent.id, agent]));
		const id = directConversationId("Main", "Child");
		expect((await store.conversations("Child", agents)).find(item => item.id === id)?.unread).toBe(1);
		expect(
			(await store.conversations("Main", new Map(registry.list().map(agent => [agent.id, agent])))).find(
				item => item.id === id,
			)?.unread,
		).toBe(0);
	});

	test("12 read-through is latest-only and never regresses", async () => {
		const { service, store } = await fixture();
		const first = await service.sendDirect("Main", "Child", "one");
		await service.sendDirect("Main", "Child", "two");
		const id = first.conversationId;
		await store.markRead("Child", id);
		await store.markRead("Child", id, first.ts);
		const agents = new Map(service.identities().map(agent => [agent.id, agent]));
		expect((await store.conversations("Child", agents)).find(item => item.id === id)?.unread).toBe(0);
	});

	test("13 child-only group excludes parent and delivers once per other member", async () => {
		const { service, sessions } = await fixture();
		const channel = await service.createChannel("Child", "Children", ["Sibling", "Grandchild"]);
		const entry = await service.sendGroup("Child", channel.id, "review");
		expect(channel.members).toEqual(["Child", "Grandchild", "Sibling"]);
		expect(entry.delivery?.map(item => item.to).sort()).toEqual(["Grandchild", "Sibling"]);
		expect(sessions.get("Main")?.delivered).toHaveLength(0);
	});

	test("14 current-tree, workspace and global stores are isolated", async () => {
		const { service } = await fixture();
		const tree = { kind: "tree", id: "/repo/.trees/current" } as const;
		const workspace = { kind: "workspace", id: "/repo" } as const;
		const global = { kind: "global", id: "installation" } as const;
		await service.sendDirect("Main", "Child", "tree", undefined, tree);
		await service.sendDirect("Main", "Child", "workspace", undefined, workspace);
		await service.sendDirect("Main", "Child", "global", undefined, global);
		const id = directConversationId("Main", "Child");
		expect((await service.history(id, tree)).map(item => item.body)).toEqual(["tree"]);
		expect((await service.history(id, workspace)).map(item => item.body)).toEqual(["workspace"]);
		expect((await service.history(id, global)).map(item => item.body)).toEqual(["global"]);
		expect(() => service.storeFor({ kind: "../escape" as "tree", id: "bad" })).toThrow(/Unsupported Hub inbox scope/);
	});

	test("15 long encoded IDs, deduplication and live events remain exact", async () => {
		const { service, store } = await fixture();
		const events: string[] = [];
		service.onEvent(event => {
			if (event.type === "entry") events.push(event.entry.id);
		});
		const longId = "deep/tree agent:α/".repeat(20);
		const conversationId = directConversationId("Main", longId);
		const entry = {
			id: "stable-event",
			conversationId,
			kind: "message" as const,
			senderId: "Main",
			body: "once",
			ts: 1,
		};
		await store.append(entry);
		await store.append(entry);
		await service.recordLifecycle(conversationId, "delivered", { action: "delivery", detail: "live" });
		expect(await store.history(conversationId)).toHaveLength(2);
		expect(events).toHaveLength(1);
		expect(conversationId).toContain(encodeURIComponent(longId));
	});
});
