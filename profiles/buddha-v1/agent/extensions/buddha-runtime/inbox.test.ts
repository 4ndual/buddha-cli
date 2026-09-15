import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuddhaHubInbox, BuddhaHubStore } from "./inbox";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class TestBus {
	#listeners = new Set<(message: any, receipt: any) => void | Promise<void>>();
	#sequence = 0;

	onDelivery(listener: (message: any, receipt: any) => void | Promise<void>) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async sendTracked(message: any, options?: { suppressObservers?: boolean }) {
		const tracked = { ...message, id: `hub-${++this.#sequence}`, ts: Date.now() + this.#sequence };
		const receipt = { to: tracked.to, outcome: "injected" as const };
		if (!options?.suppressObservers)
			await Promise.all([...this.#listeners].map(listener => listener(tracked, receipt)));
		return { message: tracked, receipt };
	}

	async send(message: any, options?: { suppressObservers?: boolean }) {
		return (await this.sendTracked(message, options)).receipt;
	}
}

describe("Buddha Hub durable projection", () => {
	test("keeps direct sends and replies visible to both agents after reopening the store", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "buddha-hub-store-"));
		roots.push(root);
		const scope = { kind: "root", id: "parent-session" };
		const refs = new Map([
			["Main", { id: "Main", displayName: "main", kind: "main", status: "idle" }],
			["Child", { id: "Child", displayName: "Child", kind: "sub", status: "idle", parentId: "Main" }],
		]);
		const registry = {
			get: (id: string) => refs.get(id),
			list: () => [...refs.values()],
			listVisibleTo: (id: string) => [...refs.values()].filter(ref => ref.id !== id),
		} as any;
		const bus = new TestBus();
		const inbox = new BuddhaHubInbox(root, scope, registry, bus as any);

		const sent = await inbox.sendDirect("Main", "Child", "parent-to-child");
		const reply = await inbox.sendDirect("Child", "Main", "child-to-parent", sent.id);
		expect(reply.replyTo).toBe(sent.id);
		inbox.dispose();

		const reopened = new BuddhaHubStore(root, scope);
		const conversationId = sent.conversationId;
		expect((await reopened.history(conversationId)).map(entry => entry.body)).toEqual([
			"parent-to-child",
			"child-to-parent",
		]);
		const mainView = await reopened.conversations("Main", refs as any);
		const childView = await reopened.conversations("Child", refs as any);
		expect(mainView.find(item => item.id === conversationId)).toMatchObject({
			preview: "child-to-parent",
			unread: 1,
		});
		expect(childView.find(item => item.id === conversationId)).toMatchObject({
			preview: "child-to-parent",
			unread: 1,
		});

		await reopened.markRead("Main", conversationId);
		const restartedAgain = new BuddhaHubStore(root, scope);
		expect((await restartedAgain.conversations("Main", refs as any)).find(item => item.id === conversationId)?.unread).toBe(0);
	});
});
