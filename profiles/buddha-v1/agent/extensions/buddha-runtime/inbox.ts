import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IrcBus, IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

export interface HubScope {
	kind: string;
	id: string;
}

interface TimelineEntry {
	id: string;
	conversationId: string;
	kind: "message" | "async_result" | "lifecycle";
	senderId?: string;
	body: string;
	ts: number;
	replyTo?: string;
	delivery?: IrcDeliveryReceipt[];
	metadata?: Record<string, unknown>;
}

interface Channel {
	id: string;
	name: string;
	members: string[];
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

interface PersistedInbox {
	version: 1;
	channels: Channel[];
	entries: TimelineEntry[];
	readThrough: Record<string, Record<string, number>>;
}

const emptyState = (): PersistedInbox => ({ version: 1, channels: [], entries: [], readThrough: {} });

function scopeKey(scope: HubScope): string {
	const id = scope.id.trim();
	if (!scope.kind.trim() || !id) throw new Error("Hub inbox scope kind and id are required");
	return `${scope.kind}-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

function directId(left: string, right: string): string {
	if (!left.trim() || !right.trim() || left === right) throw new Error("A direct conversation requires two agents");
	return `direct:${[left, right].sort().map(encodeURIComponent).join(":")}`;
}

function members(values: string[]): string[] {
	return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

export class BuddhaHubStore {
	readonly file: string;
	#state?: PersistedInbox;
	#writeTail = Promise.resolve();

	constructor(readonly dataDirectory: string, readonly scope: HubScope) {
		this.file = path.join(dataDirectory, "hub-inbox", `${scopeKey(scope)}.json`);
	}

	async #load(): Promise<PersistedInbox> {
		if (this.#state) return this.#state;
		try {
			const candidate = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<PersistedInbox>;
			this.#state = {
				version: 1,
				channels: Array.isArray(candidate.channels) ? candidate.channels : [],
				entries: Array.isArray(candidate.entries) ? candidate.entries : [],
				readThrough:
					candidate.readThrough && typeof candidate.readThrough === "object" ? candidate.readThrough : {},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.#state = emptyState();
		}
		return this.#state;
	}

	async #mutate<T>(change: (state: PersistedInbox) => T): Promise<T> {
		let result: T | undefined;
		this.#writeTail = this.#writeTail.then(async () => {
			const state = await this.#load();
			result = change(state);
			await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
			const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
			await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
			await fs.rename(temporary, this.file);
		});
		await this.#writeTail;
		return result as T;
	}

	async append(entry: TimelineEntry): Promise<TimelineEntry> {
		return this.#mutate(state => {
			const existing = state.entries.find(item => item.id === entry.id);
			if (existing) return structuredClone(existing);
			const stored = { ...structuredClone(entry), ts: Math.max(entry.ts, (state.entries.at(-1)?.ts ?? 0) + 1) };
			state.entries.push(stored);
			const channel = state.channels.find(item => item.id === entry.conversationId);
			if (channel) channel.updatedAt = Math.max(channel.updatedAt, stored.ts);
			return structuredClone(stored);
		});
	}

	async history(conversationId: string): Promise<TimelineEntry[]> {
		return (await this.#load()).entries
			.filter(entry => entry.conversationId === conversationId)
			.map(entry => structuredClone(entry));
	}

	async markRead(agentId: string, conversationId: string, through?: number): Promise<void> {
		await this.#mutate(state => {
			const latest = state.entries.filter(entry => entry.conversationId === conversationId).at(-1)?.ts ?? 0;
			const reads = (state.readThrough[agentId] ??= {});
			reads[conversationId] = Math.max(reads[conversationId] ?? 0, Math.min(through ?? latest, latest));
		});
	}

	async conversations(agentId: string, agents: Map<string, AgentRef>) {
		const state = await this.#load();
		const ids = new Set<string>(["broadcast:all"]);
		for (const peer of agents.values()) if (peer.id !== agentId) ids.add(directId(agentId, peer.id));
		for (const channel of state.channels) if (channel.members.includes(agentId)) ids.add(channel.id);
		for (const entry of state.entries) {
			if (entry.senderId === agentId || entry.conversationId.includes(encodeURIComponent(agentId))) ids.add(entry.conversationId);
		}
		return [...ids]
			.map(id => {
				const channel = state.channels.find(item => item.id === id);
				const entries = state.entries.filter(entry => entry.conversationId === id);
				const last = entries.at(-1);
				const isBroadcast = id === "broadcast:all";
				const directMembers = id.startsWith("direct:")
					? id.slice("direct:".length).split(":").map(decodeURIComponent)
					: [];
				const selectedMembers = channel?.members ?? directMembers;
				const peer = selectedMembers.find(member => member !== agentId);
				const readThrough = state.readThrough[agentId]?.[id] ?? 0;
				return {
					id,
					kind: isBroadcast ? "broadcast" : channel ? "group" : "direct",
					title: isBroadcast ? "Broadcasts" : channel?.name ?? agents.get(peer ?? "")?.displayName ?? peer ?? id,
					members: selectedMembers,
					preview: last?.body,
					updatedAt: last?.ts ?? channel?.updatedAt ?? 0,
					unread: entries.filter(entry => entry.ts > readThrough && entry.senderId !== agentId).length,
				};
			})
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async createChannel(name: string, channelMembers: string[], createdBy: string): Promise<Channel> {
		if (!name.trim()) throw new Error("Channel name is required");
		return this.#mutate(state => {
			const normalized = members([...channelMembers, createdBy]);
			if (normalized.length < 2) throw new Error("A channel requires at least two members");
			const now = Date.now();
			const channel = { id: `group:${randomUUID()}`, name: name.trim(), members: normalized, createdBy, createdAt: now, updatedAt: now };
			state.channels.push(channel);
			return structuredClone(channel);
		});
	}

	async listChannels(agentId?: string): Promise<Channel[]> {
		return (await this.#load()).channels
			.filter(channel => !agentId || channel.members.includes(agentId))
			.map(channel => structuredClone(channel));
	}

	async channel(channelId: string): Promise<Channel | undefined> {
		const channel = (await this.#load()).channels.find(item => item.id === channelId);
		return channel && structuredClone(channel);
	}

	async changeMembership(channelId: string, agentId: string, join: boolean): Promise<Channel> {
		return this.#mutate(state => {
			const channel = state.channels.find(item => item.id === channelId);
			if (!channel) throw new Error(`Unknown Hub channel "${channelId}"`);
			channel.members = join ? members([...channel.members, agentId]) : channel.members.filter(id => id !== agentId);
			channel.updatedAt = Date.now();
			return structuredClone(channel);
		});
	}
}

export class BuddhaHubInbox {
	readonly store: BuddhaHubStore;
	readonly #stopObserving: () => void;

	constructor(
		dataDirectory: string,
		scope: HubScope,
		readonly registry: AgentRegistry,
		readonly bus: IrcBus,
	) {
		this.store = new BuddhaHubStore(dataDirectory, scope);
		this.#stopObserving = this.bus.onDelivery((message, receipt) => this.#recordDelivery(message, receipt));
	}

	dispose(): void {
		this.#stopObserving();
	}

	async #recordDelivery(message: IrcMessage, receipt: IrcDeliveryReceipt): Promise<void> {
		if (!message.extensionScope || scopeKey(message.extensionScope) !== scopeKey(this.store.scope)) return;
		await this.store.append({
			id: message.id,
			conversationId: directId(message.from, message.to),
			kind: "message",
			senderId: message.from,
			body: message.body,
			ts: message.ts,
			replyTo: message.replyTo,
			delivery: [receipt],
		});
	}

	#agent(id: string): AgentRef {
		const agent = this.registry.get(id);
		if (!agent || agent.kind === "advisor" || agent.status === "aborted") throw new Error(`Agent "${id}" is not sendable`);
		return agent;
	}

	identities(): AgentRef[] {
		return this.registry.list().filter(agent => agent.kind !== "advisor" && agent.status !== "aborted");
	}

	async createChannel(from: string, name: string, channelMembers: string[]) {
		this.#agent(from);
		for (const member of channelMembers) this.#agent(member);
		return this.store.createChannel(name, channelMembers, from);
	}

	listChannels(agentId?: string) {
		if (agentId) this.#agent(agentId);
		return this.store.listChannels(agentId);
	}

	joinChannel(channelId: string, agentId: string) {
		this.#agent(agentId);
		return this.store.changeMembership(channelId, agentId, true);
	}

	leaveChannel(channelId: string, agentId: string) {
		this.#agent(agentId);
		return this.store.changeMembership(channelId, agentId, false);
	}

	async sendDirect(from: string, to: string, body: string, replyTo?: string) {
		this.#agent(from);
		this.#agent(to);
		if (!body.trim()) throw new Error("Message body is required");
		const tracked = await this.bus.sendTracked({ from, to, body: body.trim(), replyTo, extensionScope: this.store.scope });
		const entry = (await this.store.history(directId(from, to))).find(item => item.id === tracked.message.id);
		if (!entry) throw new Error(`Hub message delivery to "${to}" was not recorded`);
		return entry;
	}

	async sendGroup(from: string, channelId: string, body: string, replyTo?: string) {
		this.#agent(from);
		if (!body.trim()) throw new Error("Message body is required");
		const channel = await this.store.channel(channelId);
		if (!channel?.members.includes(from)) throw new Error(`Agent "${from}" is not a member of "${channelId}"`);
		const delivery = await Promise.all(channel.members.filter(id => id !== from).map(to =>
			this.bus.send({ from, to, body: body.trim(), replyTo, extensionScope: this.store.scope }, { suppressObservers: true }),
		));
		return this.store.append({ id: randomUUID(), conversationId: channelId, kind: "message", senderId: from, body: body.trim(), ts: Date.now(), replyTo, delivery });
	}

	async broadcast(from: string, body: string) {
		this.#agent(from);
		if (!body.trim()) throw new Error("Message body is required");
		const delivery = await Promise.all(this.registry.listVisibleTo(from).map(agent =>
			this.bus.send({ from, to: agent.id, body: body.trim(), extensionScope: this.store.scope }, { suppressObservers: true }),
		));
		return this.store.append({ id: randomUUID(), conversationId: "broadcast:all", kind: "message", senderId: from, body: body.trim(), ts: Date.now(), delivery });
	}
}
