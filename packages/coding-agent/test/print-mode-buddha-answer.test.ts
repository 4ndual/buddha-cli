/**
 * Contract: in Buddha mode, print mode delivers the promoted worker answer to
 * stdout. The answer is deliberately absent from Buddha's own context, so the
 * final-assistant-text loop alone would leave the user with nothing but
 * Buddha's short acknowledgement. It must be printed once, ahead of that
 * acknowledgement, and only for Buddha sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SIDDHI_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/buddha/types";
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

function promotion(content: string): AgentSessionEvent {
	return {
		type: "irc_message",
		message: {
			role: "custom",
			customType: SIDDHI_RESULT_MESSAGE_TYPE,
			content,
			display: true,
			details: { jobId: "job_1" },
			attribution: "agent",
			timestamp: Date.now(),
		},
	};
}

/** Mock root session whose turn emits `promotions` before settling on `finalText`. */
function createSession(options: { buddha: boolean; promotions: string[]; finalText: string }): AgentSession {
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
		settings: { get: (key: string) => (key === "buddha.enabled" ? options.buddha : false) },
		extensionRunner: undefined,
		setTextOutputCommitted: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		prompt: async () => {
			// Promotions reach the session inside the turn, before the model's own
			// closing message — exactly where `siddhi` runs.
			for (const content of options.promotions) subscriber?.(promotion(content));
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

describe("print mode Buddha answer delivery", () => {
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

	it("prints the newest promoted answer once, ahead of Buddha's own reply", async () => {
		const session = createSession({
			buddha: true,
			// The routing loop promotes per round, and Buddha re-delegates because
			// it cannot see any answer: several promotions, one user-visible answer.
			promotions: ["first attempt", "SECRET_MARKER_7741"],
			finalText: "I could not retrieve the marker line.",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe("SECRET_MARKER_7741\nI could not retrieve the marker line.\n");
	});

	it("keeps the real answer when the last promotion is only a harness banner", async () => {
		const session = createSession({
			buddha: true,
			promotions: ["SECRET_MARKER_7741", SUBAGENT_WARNING_NULL_YIELD],
			finalText: "done",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe("SECRET_MARKER_7741\ndone\n");
	});

	it("keeps a banner-prefixed answer, banner and all", async () => {
		const session = createSession({
			buddha: true,
			promotions: [`${SUBAGENT_WARNING_NULL_YIELD}\n\nSECRET_MARKER_7741`],
			finalText: "done",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe(`${SUBAGENT_WARNING_NULL_YIELD}\n\nSECRET_MARKER_7741\ndone\n`);
	});

	it("ignores promoted answers outside Buddha mode", async () => {
		const session = createSession({
			buddha: false,
			promotions: ["SECRET_MARKER_7741"],
			finalText: "ordinary reply",
		});

		await runPrintMode(session, { mode: "text", initialMessage: "read notes.txt" });

		expect(stdout.join("")).toBe("ordinary reply\n");
	});
});
