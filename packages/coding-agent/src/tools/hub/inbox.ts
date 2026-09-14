import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { IrcBus, type IrcDeliveryReceipt } from "../../irc/bus";
import type { AgentRef, AgentRegistry } from "../../registry/agent-registry";

export type HubInboxScopeKind = "root" | "workspace" | "tree" | "global";

export interface HubInboxScope {
	kind: HubInboxScopeKind;
	/** Stable, canonical identity supplied by the host (session root, workspace, tree, or installation). */
	id: string;
}

export type HubConversationKind = "direct" | "group";
export type HubTimelineKind = "message" | "async_result" | "lifecycle";

export interface HubTimelineEntry {
	id: string;
	conversationId: string;
	kind: HubTimelineKind;
	senderId?: string;
	body: string;
	ts: number;
	replyTo?: string;
	delivery?: IrcDeliveryReceipt[];
	metadata?: Record<string, unknown>;
}

export interface HubChannel {
	id: string;
	name: string;
	members: string[];
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface HubConversationSummary {
	id: string;
	kind: HubConversationKind;
	title: string;
	members: string[];
	preview?: string;
	updatedAt: number;
	unread: number;
}

interface PersistedInbox {
	version: 1;
	channels: HubChannel[];
	entries: HubTimelineEntry[];
	readThrough: Record<string, Record<string, number>>;
}

const EMPTY: PersistedInbox = { version: 1, channels: [], entries: [], readThrough: {} };

export function hubScopeKey(scope: HubInboxScope): string {
	const id = scope.id.trim();
	if (!id) throw new Error("Hub inbox scope id is required");
	return `${scope.kind}-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

export function directConversationId(left: string, right: string): string {
	if (!left.trim() || !right.trim() || left === right) throw new Error("A direct conversation requires two agents");
	return `direct:${[left, right].sort().map(encodeURIComponent).join(":")}`;
}

function cleanMembers(members: string[]): string[] {
	return [...new Set(members.map(member => member.trim()).filter(Boolean))].sort();
}

function validateState(value: unknown): PersistedInbox {
	if (!value || typeof value !== "object") return structuredClone(EMPTY);
	const candidate = value as Partial<PersistedInbox>;
	return {
		version: 1,
		channels: Array.isArray(candidate.channels) ? candidate.channels : [],
		entries: Array.isArray(candidate.entries) ? candidate.entries : [],
		readThrough: candidate.readThrough && typeof candidate.readThrough === "object" ? candidate.readThrough : {},
	};
}

/** JSON-backed scope store. Writes are serialized and replaced atomically. */
export class HubInboxStore {
	readonly file: string;
	#state?: PersistedInbox;
	#writeTail: Promise<void> = Promise.resolve();

	constructor(dataDirectory: string, scope: HubInboxScope) {
		this.file = path.join(dataDirectory, "hub-inbox", `${hubScopeKey(scope)}.json`);
	}

	async #load(): Promise<PersistedInbox> {
		if (this.#state) return this.#state;
		try {
			this.#state = validateState(JSON.parse(await fs.readFile(this.file, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.#state = structuredClone(EMPTY);
		}
		return this.#state;
	}

	async #mutate<T>(change: (state: PersistedInbox) => T): Promise<T> {
		let result!: T;
		this.#writeTail = this.#writeTail.then(async () => {
			const state = await this.#load();
			result = change(state);
			await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
			const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
			await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
			await fs.rename(temporary, this.file);
		});
		await this.#writeTail;
		return result;
	}

	async createChannel(name: string, members: string[], createdBy: string): Promise<HubChannel> {
		const normalized = cleanMembers([...members, createdBy]);
		if (!name.trim()) throw new Error("Channel name is required");
		if (normalized.length < 2) throw new Error("A channel requires at least two members");
		return this.#mutate(state => {
			const now = Date.now();
			const channel: HubChannel = {
				id: `group:${randomUUID()}`,
				name: name.trim(),
				members: normalized,
				createdBy,
				createdAt: now,
				updatedAt: now,
			};
			state.channels.push(channel);
			return structuredClone(channel);
		});
	}

	async listChannels(agentId?: string): Promise<HubChannel[]> {
		const state = await this.#load();
		return state.channels
			.filter(channel => !agentId || channel.members.includes(agentId))
			.map(channel => structuredClone(channel));
	}

	async channel(channelId: string): Promise<HubChannel | undefined> {
		const found = (await this.#load()).channels.find(channel => channel.id === channelId);
		return found && structuredClone(found);
	}

	async join(channelId: string, agentId: string): Promise<HubChannel> {
		return this.#mutate(state => {
			const channel = state.channels.find(item => item.id === channelId);
			if (!channel) throw new Error(`Unknown Hub channel "${channelId}"`);
			channel.members = cleanMembers([...channel.members, agentId]);
			channel.updatedAt = Date.now();
			return structuredClone(channel);
		});
	}

	async leave(channelId: string, agentId: string): Promise<HubChannel> {
		return this.#mutate(state => {
			const channel = state.channels.find(item => item.id === channelId);
			if (!channel) throw new Error(`Unknown Hub channel "${channelId}"`);
			channel.members = channel.members.filter(member => member !== agentId);
			channel.updatedAt = Date.now();
			return structuredClone(channel);
		});
	}

	async append(entry: HubTimelineEntry): Promise<HubTimelineEntry> {
		return this.#mutate(state => {
			const latestTs = state.entries.at(-1)?.ts ?? 0;
			const stored = { ...structuredClone(entry), ts: Math.max(entry.ts, latestTs + 1) };
			state.entries.push(stored);
			const channel = state.channels.find(item => item.id === entry.conversationId);
			if (channel) channel.updatedAt = Math.max(channel.updatedAt, stored.ts);
			return structuredClone(stored);
		});
	}

	async history(conversationId: string): Promise<HubTimelineEntry[]> {
		return (await this.#load()).entries
			.filter(entry => entry.conversationId === conversationId)
			.map(entry => structuredClone(entry));
	}

	async markRead(agentId: string, conversationId: string, through = Date.now()): Promise<void> {
		await this.#mutate(state => {
			(state.readThrough[agentId] ??= {})[conversationId] = through;
		});
	}

	async conversations(agentId: string, agents: Map<string, AgentRef>): Promise<HubConversationSummary[]> {
		const state = await this.#load();
		const ids = new Set<string>();
		for (const entry of state.entries) {
			if (entry.senderId === agentId || entry.conversationId.includes(encodeURIComponent(agentId)))
				ids.add(entry.conversationId);
		}
		for (const channel of state.channels) if (channel.members.includes(agentId)) ids.add(channel.id);
		const summaries: HubConversationSummary[] = [];
		for (const id of ids) {
			const channel = state.channels.find(item => item.id === id);
			const entries = state.entries.filter(entry => entry.conversationId === id);
			const last = entries.at(-1);
			const members = channel?.members ?? [...id.slice("direct:".length).split(":").map(decodeURIComponent)];
			const peer = members.find(member => member !== agentId);
			const readThrough = state.readThrough[agentId]?.[id] ?? 0;
			summaries.push({
				id,
				kind: channel ? "group" : "direct",
				title: channel?.name ?? agents.get(peer ?? "")?.displayName ?? peer ?? id,
				members,
				preview: last?.body,
				updatedAt: last?.ts ?? channel?.updatedAt ?? 0,
				unread: entries.filter(entry => entry.ts > readThrough && entry.senderId !== agentId).length,
			});
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

export type HubLiveEvent =
	| { type: "entry"; entry: HubTimelineEntry }
	| { type: "broadcast"; id: string; from: string; body: string; ts: number; receipts: IrcDeliveryReceipt[] };

/** Host-facing native inbox API layered on the existing IrcBus. */
export class HubInboxService {
	readonly #listeners = new Set<(event: HubLiveEvent) => void>();
	constructor(
		readonly store: HubInboxStore,
		readonly registry: AgentRegistry,
		readonly bus = IrcBus.global(),
	) {}

	onEvent(listener: (event: HubLiveEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#emit(event: HubLiveEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
	#agent(id: string): AgentRef {
		const ref = this.registry.get(id);
		if (!ref || ref.kind === "advisor" || ref.status === "aborted") throw new Error(`Agent "${id}" is not sendable`);
		return ref;
	}

	identities(): AgentRef[] {
		return this.registry.list().filter(ref => ref.kind !== "advisor" && ref.status !== "aborted");
	}
	async createChannel(from: string, name: string, members: string[]): Promise<HubChannel> {
		this.#agent(from);
		for (const member of members) this.#agent(member);
		return this.store.createChannel(name, members, from);
	}
	listChannels(agentId?: string): Promise<HubChannel[]> {
		if (agentId) this.#agent(agentId);
		return this.store.listChannels(agentId);
	}
	async joinChannel(channelId: string, agentId: string): Promise<HubChannel> {
		this.#agent(agentId);
		return this.store.join(channelId, agentId);
	}
	leaveChannel(channelId: string, agentId: string): Promise<HubChannel> {
		this.#agent(agentId);
		return this.store.leave(channelId, agentId);
	}

	async sendDirect(from: string, to: string, body: string, replyTo?: string): Promise<HubTimelineEntry> {
		this.#agent(from);
		this.#agent(to);
		if (from === to) throw new Error("Cannot send a message to yourself");
		if (!body.trim()) throw new Error("Message body is required");
		const receipt = await this.bus.send({ from, to, body: body.trim(), replyTo });
		const entry = await this.store.append({
			id: randomUUID(),
			conversationId: directConversationId(from, to),
			kind: "message",
			senderId: from,
			body: body.trim(),
			ts: Date.now(),
			replyTo,
			delivery: [receipt],
		});
		this.#emit({ type: "entry", entry });
		return entry;
	}

	async sendGroup(from: string, channelId: string, body: string, replyTo?: string): Promise<HubTimelineEntry> {
		this.#agent(from);
		const channel = await this.store.channel(channelId);
		if (!channel || !channel.members.includes(from))
			throw new Error(`Agent "${from}" is not a member of "${channelId}"`);
		if (!body.trim()) throw new Error("Message body is required");
		const receipts = await Promise.all(
			channel.members.filter(id => id !== from).map(to => this.bus.send({ from, to, body: body.trim(), replyTo })),
		);
		const entry = await this.store.append({
			id: randomUUID(),
			conversationId: channelId,
			kind: "message",
			senderId: from,
			body: body.trim(),
			ts: Date.now(),
			replyTo,
			delivery: receipts,
		});
		this.#emit({ type: "entry", entry });
		return entry;
	}

	async broadcast(from: string, body: string): Promise<HubLiveEvent> {
		this.#agent(from);
		if (!body.trim()) throw new Error("Message body is required");
		const receipts = await Promise.all(
			this.registry.listVisibleTo(from).map(ref => this.bus.send({ from, to: ref.id, body: body.trim() })),
		);
		const event: HubLiveEvent = {
			type: "broadcast",
			id: randomUUID(),
			from,
			body: body.trim(),
			ts: Date.now(),
			receipts,
		};
		this.#emit(event);
		return event;
	}

	async recordEvent(
		conversationId: string,
		kind: Exclude<HubTimelineKind, "message">,
		body: string,
		metadata?: Record<string, unknown>,
	): Promise<HubTimelineEntry> {
		const entry = await this.store.append({ id: randomUUID(), conversationId, kind, body, ts: Date.now(), metadata });
		this.#emit({ type: "entry", entry });
		return entry;
	}
}
