import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { directConversationId, HubInboxService, HubInboxStore } from "../../src/tools/hub/inbox";

const temporary: string[] = [];
afterEach(async () =>
	Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))),
);

async function fixture(scopeId = "root-a") {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hub-inbox-"));
	temporary.push(directory);
	const registry = new AgentRegistry();
	for (const id of ["Main", "Child", "Sibling"]) {
		registry.register({ id, displayName: id, kind: id === "Main" ? "main" : "sub", session: null, status: "idle" });
	}
	const sent: Array<{ from: string; to: string; body: string }> = [];
	const bus = {
		send: async (message: { from: string; to: string; body: string }) => {
			sent.push(message);
			return { to: message.to, outcome: "injected" as const };
		},
	} as IrcBus;
	const store = new HubInboxStore(directory, { kind: "root", id: scopeId });
	return { directory, registry, store, service: new HubInboxService(store, registry, bus), sent };
}

describe("native Hub inbox", () => {
	test("persists direct history, reply and read state across store instances", async () => {
		const { directory, service, store } = await fixture();
		const first = await service.sendDirect("Main", "Child", "hello");
		await service.sendDirect("Child", "Main", "done", first.id);
		const conversationId = directConversationId("Main", "Child");
		await store.markRead("Main", conversationId, first.ts);

		const restored = new HubInboxStore(directory, { kind: "root", id: "root-a" });
		expect((await restored.history(conversationId)).map(item => [item.body, item.replyTo])).toEqual([
			["hello", undefined],
			["done", first.id],
		]);
		expect((await restored.conversations("Main", new Map())).at(0)?.unread).toBe(1);
	});

	test("keeps scopes isolated and group channels persistent", async () => {
		const { directory, service, sent } = await fixture();
		const channel = await service.createChannel("Main", "Reviewers", ["Child", "Sibling"]);
		await service.sendGroup("Child", channel.id, "please review");
		expect(sent.map(item => item.to).sort()).toEqual(["Main", "Sibling"]);
		const restored = new HubInboxStore(directory, { kind: "root", id: "root-a" });
		expect((await restored.listChannels("Main"))[0]?.members).toEqual(["Child", "Main", "Sibling"]);
		expect((await restored.history(channel.id))[0]?.body).toBe("please review");
		expect(await new HubInboxStore(directory, { kind: "workspace", id: "root-a" }).listChannels()).toEqual([]);
	});

	test("broadcast is emitted and persisted exactly once", async () => {
		const { service, store, sent } = await fixture();
		const events: unknown[] = [];
		service.onEvent(event => events.push(event));
		await service.broadcast("Main", "heads up");
		expect(sent.map(item => item.to).sort()).toEqual(["Child", "Sibling"]);
		expect(events).toHaveLength(1);
		expect((await store.history("broadcast:all")).map(entry => entry.body)).toEqual(["heads up"]);
		expect((await store.conversations("Main", new Map())).filter(item => item.id === "broadcast:all")).toHaveLength(1);
	});
});
