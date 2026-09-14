import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";
import {
	TASK_LIFECYCLE_SERVICE,
	type TaskLifecycleMetadata,
	type TaskLifecycleService,
} from "@oh-my-pi/pi-coding-agent/task/lifecycle-service";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { buildToolSession } from "../../runtime/siddhi-tool";

type CompletionVerdict = "APPROVE" | "ADVISE" | "REJECT" | "KILL_REQUEST";
type CompletionReview = { verdict: CompletionVerdict; summary: string };
type CompleteDetails = {
	result: string;
	status: "success" | "advice" | "rejected" | "kill_request";
	verdict: CompletionVerdict;
	review: string;
};

const REVIEW_TIMEOUT_MS = 30_000;

function parseReview(output: string, data: unknown): CompletionReview {
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const record = data as Record<string, unknown>;
		if (["APPROVE", "ADVISE", "REJECT", "KILL_REQUEST"].includes(String(record.verdict))) {
			return {
				verdict: record.verdict as CompletionVerdict,
				summary: typeof record.summary === "string" ? record.summary : output,
			};
		}
	}
	const verdict = output.match(/\b(APPROVE|ADVISE|REJECT|KILL_REQUEST)\b/)?.[1] as CompletionVerdict | undefined;
	return verdict ? { verdict, summary: output } : { verdict: "REJECT", summary: "Gate reviewer returned no verdict." };
}

function currentToolSession(context: ExtensionContext) {
	return buildToolSession(context as never);
}

async function lifecycleReview(
	checkpoint: "CHECK_1" | "CHECK_2" | "HARD_CANCEL",
	metadata: TaskLifecycleMetadata,
	session: ToolSession,
) {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new DOMException("lifecycle review timed out", "TimeoutError")),
		checkpoint === "HARD_CANCEL" ? 30_000 : 20_000,
	);
	try {
		const assignment =
			checkpoint === "HARD_CANCEL"
				? `Report the owned hard-stop cancellation of ${metadata.lineageId}. Never resume it. Reply with a concise report.`
				: [
						"Review the active delegated task at its lifecycle checkpoint.",
						`Agent: ${metadata.lineageId}`,
						`Checkpoint: ${checkpoint}`,
						`Runtime tier: ${metadata.params.rt ?? "unknown"}`,
						`Task: ${metadata.params.task ?? "(unavailable)"}`,
						"Reply with exactly ATOMIC or DECOMPOSED, followed by a brief reason.",
					].join("\n");
		const result = await runStructuredSubagent({
			session,
			invocationKind: "task",
			agent: "atomic-task-reviewer",
			assignment,
			context: JSON.stringify(metadata),
			identity: { label: "atomic-task-reviewer" },
			maxRuntimeMs: checkpoint === "HARD_CANCEL" ? 30_000 : 20_000,
			keepAlive: false,
			signal: controller.signal,
		});
		const review = result.result.output.trim();
		if (checkpoint === "HARD_CANCEL")
			return { message: `Hard-cancelled ${metadata.lineageId}; reviewer report: ${review}` };
		return /^\s*DECOMPOSED\b/i.test(review)
			? {
					message: `Recovery advice for ${metadata.lineageId}: atomic-task-reviewer reported DECOMPOSED (${review}).`,
				}
			: { message: `Approved ${metadata.lineageId}: atomic-task-reviewer reported ATOMIC.` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return checkpoint === "HARD_CANCEL"
			? { message: `Hard-cancelled ${metadata.lineageId}; reviewer report unavailable: ${message}` }
			: { message: `Recovery advice for ${metadata.lineageId}: lifecycle reviewer unavailable (${message}).` };
	} finally {
		clearTimeout(timeout);
	}
}

export default function buddhaTools(pi: ExtensionAPI): void {
	const lifecycle: TaskLifecycleService = {
		checkpointsMs: { check1: 3 * 60_000, check2: 5 * 60_000, hardCancel: 10 * 60_000 },
		validate(params, label) {
			if (typeof params.task !== "string" || !/^#\s*Acceptance\b/im.test(params.task)) {
				return `${label} is missing \`# Acceptance\`. Include completion tests and the expected output contract.`;
			}
			if (!params.rt) return `${label} is missing \`rt\` (expected R1-R5).`;
		},
		onCheckpoint: lifecycleReview,
		onHardCancel: (metadata, session) => lifecycleReview("HARD_CANCEL", metadata, session),
		formatTelemetry(result) {
			const telemetry = result.telemetry;
			if (!telemetry) return;
			const usage = telemetry.usage;
			const names = telemetry.tools.slice(0, 8).map(tool => tool.name);
			return [
				"Telemetry:",
				`- duration ms: ${telemetry.durationMs}`,
				`- input tokens: ${usage?.input ?? "unavailable"}`,
				`- output tokens: ${usage?.output ?? "unavailable"}`,
				`- total tokens: ${usage?.totalTokens ?? "unavailable"}`,
				`- requests: ${telemetry.requests ?? "unavailable"}`,
				`- tool calls: ${result.requests === 0 ? 0 : telemetry.tools.length}`,
				`- tools: ${names.length > 0 ? names.join(", ") : "unavailable"}`,
				`- explanation: ${telemetry.explanation}`,
			].join("\n");
		},
	};
	pi.registerExtensionService(TASK_LIFECYCLE_SERVICE, lifecycle);
	const completeSchema = pi
		.arktype({ result: "string", "+": "reject" })
		.describe("Propose the exact final result for independent gate review");
	const parentSchema = pi
		.arktype({ message: "string", await: "boolean?", "+": "reject" })
		.describe("Send a message to the parent agent and optionally await its reply");

	pi.registerTool({
		name: "complete",
		label: "Complete",
		description: "Propose the exact final result; an independent gate reviewer must approve it",
		parameters: completeSchema,
		approval: "read",
		strict: true,
		async execute(toolCallId, params, signal, _onUpdate, context) {
			const session = currentToolSession(context);
			if (!session) throw new Error("Completion gate is unavailable in this session");
			const transcript = JSON.stringify(session.sessionManager?.getEntries?.() ?? []);
			const controller = new AbortController();
			const onAbort = () => controller.abort(signal?.reason);
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			const timeout = setTimeout(
				() => controller.abort(new DOMException("completion gate timed out", "TimeoutError")),
				REVIEW_TIMEOUT_MS,
			);
			let review: CompletionReview;
			try {
				const gate = await runStructuredSubagent({
					session,
					invocationKind: "task",
					agent: "gate-reviewer",
					assignment:
						"STOP review this completion proposal. Emit exactly one APPROVE, ADVISE, REJECT, or KILL_REQUEST verdict.",
					context: `# Completion proposal\n${params.result}\n# Task context and evidence\n${transcript}`,
					identity: { label: "gate-reviewer" },
					parentToolCallId: toolCallId,
					maxRuntimeMs: REVIEW_TIMEOUT_MS,
					keepAlive: false,
					signal: controller.signal,
				});
				review = parseReview(gate.result.output, gate.result.structuredOutput?.data);
			} catch (error) {
				review = {
					verdict: "REJECT",
					summary: `Completion gate failed safely: ${error instanceof Error ? error.message : String(error)}`,
				};
			} finally {
				clearTimeout(timeout);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
			const status: CompleteDetails["status"] =
				review.verdict === "APPROVE"
					? "success"
					: review.verdict === "ADVISE"
						? "advice"
						: review.verdict === "KILL_REQUEST"
							? "kill_request"
							: "rejected";
			const details: CompleteDetails = {
				result: params.result,
				status,
				verdict: review.verdict,
				review: review.summary,
			};
			return {
				content: [
					{
						type: "text",
						text:
							status === "success"
								? params.result
								: `Completion ${status}: ${review.summary}\nContinue working and call complete again.`,
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "parent",
		label: "Parent",
		description: "Send a message to the parent agent and optionally await its reply",
		parameters: parentSchema,
		approval: "read",
		strict: true,
		async execute(_toolCallId, params, signal, _onUpdate, context) {
			const session = currentToolSession(context);
			const registry = session?.agentRegistry;
			const currentId = session?.getAgentId?.();
			const parentId = registry && currentId ? registry.get(currentId)?.parentId : undefined;
			if (!registry || !currentId || !parentId) throw new Error("Parent agent is unavailable");
			const bus = IrcBus.global();
			const reply = params.await
				? bus.wait(currentId, { from: parentId }, 30_000, signal, { awaitTarget: { registry, target: parentId } })
				: undefined;
			const receipt = await bus.send(
				{ from: currentId, to: parentId, body: params.message },
				{ expectsReply: params.await },
			);
			if (receipt.outcome === "failed") throw new Error(receipt.error ?? "Parent message delivery failed");
			return { content: [{ type: "text", text: (await reply)?.body ?? "Message sent" }] };
		},
	});
}

subprocessToolRegistry.register<Pick<CompleteDetails, "result" | "status">>("complete", {
	extractData: event => {
		const details = event.result?.details as Partial<CompleteDetails> | undefined;
		return !event.isError && details?.status === "success" && typeof details.result === "string"
			? { result: details.result, status: "success" }
			: undefined;
	},
	shouldTerminate: event => (event.result?.details as Partial<CompleteDetails> | undefined)?.status === "success",
});
