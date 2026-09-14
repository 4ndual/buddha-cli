import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { BuddhaHubInbox } from "./inbox";

export const BUDDHA_HUB_SERVICE = "buddha.hub-inbox";

class ProfileHubService {
	#service?: BuddhaHubInbox;
	#sessionId?: string;

	bind(context: ExtensionContext): void {
		const sessionId = context.sessionManager.getSessionId();
		if (this.#service && this.#sessionId === sessionId) return;
		this.#service?.dispose();
		this.#service = new BuddhaHubInbox(
			getAgentDir(),
			{ kind: "root", id: sessionId },
			AgentRegistry.global(),
			IrcBus.global(),
		);
		this.#sessionId = sessionId;
	}

	dispose(): void {
		this.#service?.dispose();
		this.#service = undefined;
		this.#sessionId = undefined;
	}

	get service(): BuddhaHubInbox {
		if (!this.#service) throw new Error("Buddha Hub service is not bound to a session");
		return this.#service;
	}

	get store() {
		return this.service.store;
	}

	identities() {
		return this.service.identities();
	}

	createChannel(...args: Parameters<BuddhaHubInbox["createChannel"]>) {
		return this.service.createChannel(...args);
	}

	listChannels(...args: Parameters<BuddhaHubInbox["listChannels"]>) {
		return this.service.listChannels(...args);
	}

	joinChannel(...args: Parameters<BuddhaHubInbox["joinChannel"]>) {
		return this.service.joinChannel(...args);
	}

	leaveChannel(...args: Parameters<BuddhaHubInbox["leaveChannel"]>) {
		return this.service.leaveChannel(...args);
	}

	sendDirect(...args: Parameters<BuddhaHubInbox["sendDirect"]>) {
		return this.service.sendDirect(...args);
	}

	sendGroup(...args: Parameters<BuddhaHubInbox["sendGroup"]>) {
		return this.service.sendGroup(...args);
	}

	broadcast(...args: Parameters<BuddhaHubInbox["broadcast"]>) {
		return this.service.broadcast(...args);
	}
}

export default function buddhaRuntime(pi: ExtensionAPI): void {
	const hub = new ProfileHubService();
	pi.registerExtensionService(BUDDHA_HUB_SERVICE, hub);
	pi.on("session_start", (_event, context) => hub.bind(context));
	pi.on("session_switch", (_event, context) => hub.bind(context));
	pi.on("session_branch", (_event, context) => hub.bind(context));
	pi.on("session_shutdown", () => hub.dispose());
}
