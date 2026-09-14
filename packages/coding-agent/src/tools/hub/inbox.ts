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

export type HubConversationKind = "direct" | "group" | "broadcast";
export type HubTimelineKind = "message" | "async_result" | "lifecycle";

interface HubTimelineEntryBase {
	id: string;
	conversationId: string;
	senderId?: string;
	body: string;
	ts: number;
	replyTo?: string;
	delivery?: IrcDeliveryReceipt[];
}

export type HubAsyncResultStatus = "succeeded" | "failed" | "cancelled";
export type HubLifecycleAction = "delivery" | "wake" | "revive" | "park" | "join" | "leave";
export type HubTimelineEntry =
	| (HubTimelineEntryBase & {
			kind: "message";
			metadata?: Record<string, unknown>;
	  })
	| (HubTimelineEntryBase & {
			kind: "async_result";
			metadata: {
				jobId: string;
				status: HubAsyncResultStatus;
				recipientId?: string;
				outputPath?: string;
			};
	  })
	| (HubTimelineEntryBase & {
			kind: "lifecycle";
			metadata: {
				action: HubLifecycleAction;
				agentId?: string;
				outcome?: IrcDeliveryReceipt["outcome"];
				detail?: string;
			};
	  });

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

const EMPTY: PersistedInbox = {
	version: 1,
	channels: [],
	entries: [],
	readThrough: {},
};
const HUB_SCOPE_KINDS = new Set<HubInboxScopeKind>(["root", "workspace", "tree", "global"]);

export function hubScopeKey(scope: HubInboxScope): string {
	if (!HUB_SCOPE_KINDS.has(scope.kind)) throw new Error(`Unsupported Hub inbox scope "${String(scope.kind)}"`);
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
	readonly scope: HubInboxScope;
	readonly dataDirectory: string;
	#state?: PersistedInbox;
	#writeTail: Promise<void> = Promise.resolve();

	constructor(dataDirectory: string, scope: HubInboxScope) {
		this.dataDirectory = dataDirectory;
		hubScopeKey(scope);
		this.scope = { kind: scope.kind, id: scope.id.trim() };
		this.file = path.join(dataDirectory, "hub-inbox", `${hubScopeKey(scope)}.json`);
	}

	forScope(scope: HubInboxScope): HubInboxStore {
		return scope.kind === this.scope.kind && scope.id === this.scope.id
			? this
			: new HubInboxStore(this.dataDirectory, scope);
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
			await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, {
				mode: 0o600,
			});
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
			const existing = state.entries.find(item => item.id === entry.id);
			if (existing) return structuredClone(existing);
			const latestTs = state.entries.at(-1)?.ts ?? 0;
			const stored = {
				...structuredClone(entry),
				ts: Math.max(entry.ts, latestTs + 1),
			};
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

	async replyTarget(conversationId: string, replyTo: string): Promise<HubTimelineEntry> {
		const target = (await this.#load()).entries.find(entry => entry.id === replyTo);
		if (!target) throw new Error(`Unknown Hub reply target "${replyTo}"`);
		if (target.conversationId !== conversationId) throw new Error("Hub replies cannot cross conversations");
		return structuredClone(target);
	}

	async markRead(agentId: string, conversationId: string, through?: number): Promise<void> {
		await this.#mutate(state => {
			const latest = state.entries.filter(entry => entry.conversationId === conversationId).at(-1)?.ts ?? 0;
			const next = Math.min(through ?? latest, latest);
			const reads = (state.readThrough[agentId] ??= {});
			reads[conversationId] = Math.max(reads[conversationId] ?? 0, next);
		});
	}

	async conversations(agentId: string, agents: Map<string, AgentRef>): Promise<HubConversationSummary[]> {
		const state = await this.#load();
		const ids = new Set<string>();
		for (const entry of state.entries) {
			const directMembers = entry.conversationId.startsWith("direct:")
				? entry.conversationId.slice("direct:".length).split(":").map(decodeURIComponent)
				: [];
			if (entry.senderId === agentId || directMembers.includes(agentId)) ids.add(entry.conversationId);
		}
		for (const peer of agents.values()) if (peer.id !== agentId) ids.add(directConversationId(agentId, peer.id));
		for (const channel of state.channels) if (channel.members.includes(agentId)) ids.add(channel.id);
		ids.add("broadcast:all");
		const summaries: HubConversationSummary[] = [];
		for (const id of ids) {
			const channel = state.channels.find(item => item.id === id);
			const entries = state.entries.filter(entry => entry.conversationId === id);
			const last = entries.at(-1);
			const broadcast = id === "broadcast:all";
			const members = broadcast
				? []
				: (channel?.members ?? [...id.slice("direct:".length).split(":").map(decodeURIComponent)]);
			const peer = members.find(member => member !== agentId);
			const readThrough = state.readThrough[agentId]?.[id] ?? 0;
			summaries.push({
				id,
				kind: broadcast ? "broadcast" : channel ? "group" : "direct",
				title: broadcast ? "Broadcasts" : (channel?.name ?? agents.get(peer ?? "")?.displayName ?? peer ?? id),
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
	| {
			type: "broadcast";
			id: string;
			from: string;
			body: string;
			ts: number;
			receipts: IrcDeliveryReceipt[];
	  };

/** Host-facing native inbox API layered on the existing IrcBus. */
export class HubInboxService {
	readonly #listeners = new Set<(event: HubLiveEvent) => void>();
	readonly #busRecordsDeliveries: boolean;
	readonly #stores = new Map<string, HubInboxStore>();
	constructor(
		readonly store: HubInboxStore,
		readonly registry: AgentRegistry,
		readonly bus = IrcBus.global(),
	) {
		this.#stores.set(hubScopeKey(store.scope), store);
		this.#busRecordsDeliveries =
			typeof this.bus.onDelivery === "function" && typeof this.bus.sendTracked === "function";
		this.bus.onDelivery?.(async (message, receipt) => {
			const entry = await this.storeFor(message.hubScope).append({
				id: message.id,
				conversationId: directConversationId(message.from, message.to),
				kind: "message",
				senderId: message.from,
				body: message.body,
				ts: message.ts,
				replyTo: message.replyTo,
				delivery: [receipt],
			});
			this.#emit({ type: "entry", entry });
		});
	}
	storeFor(scope: HubInboxScope = this.store.scope): HubInboxStore {
		const key = hubScopeKey(scope);
		let selected = this.#stores.get(key);
		if (!selected) {
			selected = this.store.forScope(scope);
			this.#stores.set(key, selected);
		}
		return selected;
	}

	async snapshot(agentId: string, scope: HubInboxScope = this.store.scope) {
		this.#agent(agentId);
		const agents = this.identities();
		return {
			agents,
			conversations: await this.storeFor(scope).conversations(
				agentId,
				new Map(agents.map(agent => [agent.id, agent])),
			),
			channels: await this.storeFor(scope).listChannels(),
			scope: { ...scope },
		};
	}
	history(conversationId: string, scope: HubInboxScope = this.store.scope): Promise<HubTimelineEntry[]> {
		return this.storeFor(scope).history(conversationId);
	}
	markRead(
		agentId: string,
		conversationId: string,
		through?: number,
		scope: HubInboxScope = this.store.scope,
	): Promise<void> {
		this.#agent(agentId);
		return this.storeFor(scope).markRead(agentId, conversationId, through);
	}

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
	async createChannel(
		from: string,
		name: string,
		members: string[],
		scope: HubInboxScope = this.store.scope,
	): Promise<HubChannel> {
		this.#agent(from);
		for (const member of members) this.#agent(member);
		return this.storeFor(scope).createChannel(name, members, from);
	}
	listChannels(agentId?: string, scope: HubInboxScope = this.store.scope): Promise<HubChannel[]> {
		if (agentId) this.#agent(agentId);
		return this.storeFor(scope).listChannels(agentId);
	}
	async joinChannel(channelId: string, agentId: string, scope: HubInboxScope = this.store.scope): Promise<HubChannel> {
		this.#agent(agentId);
		return this.storeFor(scope).join(channelId, agentId);
	}
	leaveChannel(channelId: string, agentId: string, scope: HubInboxScope = this.store.scope): Promise<HubChannel> {
		this.#agent(agentId);
		return this.storeFor(scope).leave(channelId, agentId);
	}

	async sendDirect(
		from: string,
		to: string,
		body: string,
		replyTo?: string,
		scope: HubInboxScope = this.store.scope,
	): Promise<HubTimelineEntry> {
		this.#agent(from);
		this.#agent(to);
		if (from === to) throw new Error("Cannot send a message to yourself");
		if (!body.trim()) throw new Error("Message body is required");
		const conversationId = directConversationId(from, to);
		if (replyTo) await this.storeFor(scope).replyTarget(conversationId, replyTo);
		const tracked = this.#busRecordsDeliveries
			? await this.bus.sendTracked({ from, to, body: body.trim(), replyTo, hubScope: scope })
			: undefined;
		const receipt =
			tracked?.receipt ?? (await this.bus.send({ from, to, body: body.trim(), replyTo, hubScope: scope }));
		if (!this.#busRecordsDeliveries) {
			const entry = await this.storeFor(scope).append({
				id: randomUUID(),
				conversationId,
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
		const entries = await this.storeFor(scope).history(conversationId);
		const entry = entries.find(item => item.id === tracked?.message.id);
		if (!entry) throw new Error(`Hub message delivery to "${receipt.to}" was not recorded`);
		return entry;
	}

	async sendGroup(
		from: string,
		channelId: string,
		body: string,
		replyTo?: string,
		scope: HubInboxScope = this.store.scope,
	): Promise<HubTimelineEntry> {
		this.#agent(from);
		const selectedStore = this.storeFor(scope);
		const channel = await selectedStore.channel(channelId);
		if (!channel || !channel.members.includes(from))
			throw new Error(`Agent "${from}" is not a member of "${channelId}"`);
		if (!body.trim()) throw new Error("Message body is required");
		if (replyTo) await selectedStore.replyTarget(channelId, replyTo);
		const receipts = await Promise.all(
			channel.members
				.filter(id => id !== from)
				.map(to =>
					this.bus.send({ from, to, body: body.trim(), replyTo, hubScope: scope }, { suppressInbox: true }),
				),
		);
		const entry = await selectedStore.append({
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

	async broadcast(from: string, body: string, scope: HubInboxScope = this.store.scope): Promise<HubTimelineEntry> {
		this.#agent(from);
		if (!body.trim()) throw new Error("Message body is required");
		const receipts = await Promise.all(
			this.registry
				.listVisibleTo(from)
				.map(ref =>
					this.bus.send({ from, to: ref.id, body: body.trim(), hubScope: scope }, { suppressInbox: true }),
				),
		);
		const entry = await this.storeFor(scope).append({
			id: randomUUID(),
			conversationId: "broadcast:all",
			kind: "message",
			senderId: from,
			body: body.trim(),
			ts: Date.now(),
			delivery: receipts,
		});
		const event: HubLiveEvent = {
			type: "broadcast",
			id: entry.id,
			from,
			body: entry.body,
			ts: entry.ts,
			receipts,
		};
		this.#emit(event);
		return entry;
	}

	async recordEvent(
		conversationId: string,
		kind: Exclude<HubTimelineKind, "message">,
		body: string,
		metadata: HubTimelineEntry["metadata"],
		scope: HubInboxScope = this.store.scope,
	): Promise<HubTimelineEntry> {
		const entry = await this.storeFor(scope).append({
			id: randomUUID(),
			conversationId,
			kind,
			body,
			ts: Date.now(),
			metadata,
		} as HubTimelineEntry);
		this.#emit({ type: "entry", entry });
		return entry;
	}
	async recordAsyncResult(
		conversationId: string,
		body: string,
		metadata: Extract<HubTimelineEntry, { kind: "async_result" }>["metadata"],
		scope?: HubInboxScope,
	): Promise<HubTimelineEntry> {
		return this.recordEvent(conversationId, "async_result", body, metadata, scope);
	}
	async recordLifecycle(
		conversationId: string,
		body: string,
		metadata: Extract<HubTimelineEntry, { kind: "lifecycle" }>["metadata"],
		scope?: HubInboxScope,
	): Promise<HubTimelineEntry> {
		return this.recordEvent(conversationId, "lifecycle", body, metadata, scope);
	}
}
