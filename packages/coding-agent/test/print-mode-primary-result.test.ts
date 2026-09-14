/**
 * Contract: print mode delivers a profile-promoted primary result to stdout.
 * The answer can be absent from the model's own context, so it must be printed
 * once ahead of the model acknowledgement when the owner marks it primary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SUBAGENT_WARNING_NULL_YIELD } from "@oh-my-pi/pi-coding-agent/task/executor";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {} as AssistantMessage["usage"],
		stopReason: "stop",
		timestamp: 1,
	};
}

function promotion(content: string, primaryResult: boolean): AgentSessionEvent {
	return {
		type: "irc_message",
		message: {
			role: "custom",
			customType: "test-primary-result",
			content,
			display: true,
			details: { jobId: "job_1", primaryResult },
			attribution: "agent",
			timestamp: Date.now(),
		},
	};
}

/** Mock root session whose turn emits `promotions` before settling on `finalText`. */
function createSession(options: { primaryResult: boolean; promotions: string[]; finalText: string }): AgentSession {
	const messages: AssistantMessage[] = [];
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	let advisorDrainPrepared = false;
	return {
		state: { messages },
		getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
		sessionManager: {
			getHeader: () => undefined,
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
		},
		settings: { get: () => false },
		extensionRunner: undefined,
		setTextOutputCommitted: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		prompt: async () => {
			// Promotions reach the session inside the turn, before the model's own
			// closing message — exactly where `siddhi` runs.
			for (const content of options.promotions) subscriber?.(promotion(content, options.primaryResult));
			messages.push(assistantMessage(options.finalText));
			return true;
		},
		prepareForHeadlessAdvisorDrain: () => {
			advisorDrainPrepared = true;
		},
		waitForAdvisorCatchup: async () => {
			if (!advisorDrainPrepared) throw new Error("advisor catch-up started before headless delivery was armed");
		},
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("print mode profile primary-result delivery", () => {
	let stdout: string[];

	beforeEach(() => {
		stdout = [];
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			if (typeof args[0] === "string") stdout.push(args[0]);
			const last = args[args.length - 1];
			if (typeof last === "function") (last as () => void)();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("prints the newest promoted answer once, ahead of the model reply", async () => {
		const session = createSession({
			primaryResult: true,
			// A routing loop can promote per round and re-delegate because
			// it cannot see any answer: several promotions, one user-visible answer.
			promotions: ["first attempt", "SECRET_MARKER_7741"],
			finalText: "I could not retrieve the marker line.",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe("SECRET_MARKER_7741\nI could not retrieve the marker line.\n");
	});

	it("keeps the real answer when the last promotion is only a harness banner", async () => {
		const session = createSession({
			primaryResult: true,
			promotions: ["SECRET_MARKER_7741", SUBAGENT_WARNING_NULL_YIELD],
			finalText: "done",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe("SECRET_MARKER_7741\ndone\n");
	});

	it("keeps a banner-prefixed answer, banner and all", async () => {
		const session = createSession({
			primaryResult: true,
			promotions: [`${SUBAGENT_WARNING_NULL_YIELD}\n\nSECRET_MARKER_7741`],
			finalText: "done",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe(`${SUBAGENT_WARNING_NULL_YIELD}\n\nSECRET_MARKER_7741\ndone\n`);
	});

	it("ignores unmarked promoted answers", async () => {
		const session = createSession({
			primaryResult: false,
			promotions: ["SECRET_MARKER_7741"],
			finalText: "ordinary reply",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe("ordinary reply\n");
	});
});
