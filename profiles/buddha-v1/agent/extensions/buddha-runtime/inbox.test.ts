import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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
		expect(
			(await restartedAgain.conversations("Main", refs as any)).find(item => item.id === conversationId)?.unread,
		).toBe(0);
	});
});

/**
 * A parent's transcript tree as OMP writes it: `<root>.jsonl` beside a
 * `<root>/` directory holding one file per sub-agent.
 */
async function writeTranscript(file: string, id: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		`${[
			JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id,
				timestamp: "2026-09-17T10:00:00.000Z",
				cwd: process.cwd(),
			}),
			JSON.stringify({
				type: "session_init",
				id: `si-${id}`,
				parentId: null,
				timestamp: "2026-09-17T10:00:01.000Z",
				systemPrompt: "worker",
				task: "landing a change",
				tools: ["read"],
			}),
		].join("\n")}\n`,
	);
}

describe("Buddha Hub roster after a parent restart", () => {
	test("reaches a child that outlived the parent process, and still refuses one that never existed", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "buddha-hub-roster-"));
		roots.push(home);
		const rootFile = path.join(home, "sessions", "root.jsonl");
		const childFile = path.join(home, "sessions", "root", "Child.jsonl");
		await writeTranscript(rootFile, "root");
		await writeTranscript(childFile, "Child");
		const scope = { kind: "root", id: "root" };

		// The parent's first run: a real registry holding a live child.
		const before = new AgentRegistry();
		before.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: rootFile,
			status: "idle",
		});
		before.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: childFile,
			status: "idle",
			assignment: "landing a change",
		});
		const running = new BuddhaHubInbox(home, scope, before, new IrcBus(), () => rootFile);
		expect((await running.sendDirect(MAIN_AGENT_ID, "Child", "before restart")).body).toBe("before restart");
		running.dispose();

		// The restart: a brand-new process-global registry, so nothing but the
		// resumed main agent is in memory. The child exists only on disk.
		const restarted = new AgentRegistry();
		restarted.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: rootFile,
			status: "idle",
		});
		expect(restarted.get("Child")).toBeUndefined();
		const reopened = new BuddhaHubInbox(home, scope, restarted, new IrcBus(), () => rootFile);

		expect((await reopened.identities()).map(agent => agent.id).sort()).toEqual(["Child", MAIN_AGENT_ID]);
		const delivered = await reopened.sendDirect(MAIN_AGENT_ID, "Child", "after restart");
		expect(delivered.body).toBe("after restart");
		expect(restarted.get("Child")?.sessionFile).toBe(childFile);

		// Nothing persisted, nothing in the roster: the existing refusal stands.
		await expect(reopened.sendDirect(MAIN_AGENT_ID, "Ghost", "after restart")).rejects.toThrow(
			'Agent "Ghost" is not sendable',
		);
		expect((await reopened.identities()).some(agent => agent.id === "Ghost")).toBe(false);
		expect(restarted.get("Ghost")).toBeUndefined();
		reopened.dispose();
	});

	test("restores nothing when the restarted parent has no transcript tree on disk", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "buddha-hub-roster-empty-"));
		roots.push(home);
		const rootFile = path.join(home, "sessions", "lonely.jsonl");
		await writeTranscript(rootFile, "lonely");
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: rootFile,
			status: "idle",
		});
		const inbox = new BuddhaHubInbox(home, { kind: "root", id: "lonely" }, registry, new IrcBus(), () => rootFile);

		expect((await inbox.identities()).map(agent => agent.id)).toEqual([MAIN_AGENT_ID]);
		await expect(inbox.sendDirect(MAIN_AGENT_ID, "Child", "hello")).rejects.toThrow('Agent "Child" is not sendable');
		expect(registry.list().map(agent => agent.id)).toEqual([MAIN_AGENT_ID]);
		inbox.dispose();
	});
});
