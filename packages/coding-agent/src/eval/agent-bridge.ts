/**
 * Host-side handler for the eval `agent()` helper.
 */
import { type } from "@oh-my-pi/omptype";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AsyncJobDetails } from "../async/job-manager";
import { createEvalCustomTools, describeEvalTools } from "../task/eval-tools";
import {
	buildStructuredSubagentRecoveryHint,
	reserveStructuredSubagentId,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentIsolationControls,
	type StructuredSubagentResult,
	type StructuredSubagentSchemaMode,
} from "../task/structured-subagent";
import type { AgentProgress, SingleResult } from "../task/types";
import type { NestedRepoPatch } from "../task/worktree";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type { JsStatusEvent } from "./js/shared/types";
// Import review tools for side effects (registers subagent tool handlers).
import "../tools/review";

/** Synthetic bridge name reserved for the `agent()` helper across both runtimes. */
export const EVAL_AGENT_BRIDGE_NAME = "__agent__";

const agentArgsSchema = type({
	prompt: "string>0",
	"agent?": "string>0",
	"label?": "string",
	"schema?": "unknown",
	"schemaMode?": "'permissive' | 'strict'",
	"isolated?": "boolean",
	"apply?": "boolean",
	"merge?": "boolean",
	"tools?": "string[]",
	"+": "delete",
});

interface EvalAgentArgs {
	prompt: string;
	agent?: string;
	label?: string;
	schema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	isolated?: boolean;
	apply?: boolean;
	merge?: boolean;
	tools?: string[];
}

export interface EvalAgentBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** Handle returned immediately after an eval subagent job is registered. */
export interface EvalAgentHandleResult {
	id: string;
	agent: string;
}

export interface EvalAgentResult {
	text: string;
	/** Parsed structured data returned by the child executor. */
	data?: unknown;
	details: {
		agent: string;
		id: string;
		model?: string | string[];
		structured: boolean;
		schemaSource?: "caller" | "agent" | "session";
		schemaMode?: StructuredSubagentSchemaMode;
		schemaStatus?: "valid" | "invalid";
		isolated?: boolean;
		patchPath?: string;
		/** False when `patchPath` is an empty root diff and the work lives in `nestedPatchPaths`. */
		hasRootChanges?: boolean;
		branchName?: string;
		nestedPatches?: NestedRepoPatch[];
		/** On-disk copies of `nestedPatches`, written before the isolation workspace was removed. */
		nestedPatchPaths?: string[];
		changesApplied?: boolean | null;
		isolationSummary?: string;
	};
}

function parseAgentArgs(args: unknown): EvalAgentArgs {
	const result = agentArgsSchema(args);
	if (result instanceof type.errors) {
		throw new ToolError(`agent() received invalid arguments: ${result.summary}`);
	}
	return result;
}

/** Only a profile-installed task router may opt eval agent() into fork delegation. */
function evalForkTool(session: ToolSession, agent: string | undefined) {
	const task = session.toolRegistry?.get("task");
	const select = (task as typeof task & { evalDefaultForkAgent?: unknown } | undefined)?.evalDefaultForkAgent;
	const forkAgent = typeof select === "function" ? select(session.sessionManager) : undefined;
	return typeof forkAgent === "string" && forkAgent.length > 0 && (!agent || agent === forkAgent)
		? { tool: task!, agent: forkAgent }
		: undefined;
}

async function runEvalFork(
	args: EvalAgentArgs,
	id: string,
	route: NonNullable<ReturnType<typeof evalForkTool>>,
	reportProgress: (text: string, details?: AsyncJobDetails) => Promise<void>,
	signal: AbortSignal,
): Promise<string> {
	// These controls require native structured-subagent semantics. Never discard
	// them while presenting a fork as if it honored them.
	for (const key of ["schema", "schemaMode", "isolated", "apply", "merge", "tools"] as const) {
		if (Object.hasOwn(args, key)) throw new ToolError(`agent() ${route.agent} cannot honor ${key} in a conversation fork`);
	}
	const name = `eval${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
	const invoke = async (task: string) => {
		const result = await route.tool.execute(id, { agent: route.agent, name, task } as never, signal);
		const details = result.details as { results?: Array<{ pending?: boolean; text?: string; error?: string }> } | undefined;
		const item = details?.results?.[0];
		if (result.isError || item?.error) throw new ToolError(item?.error ?? result.content.map(part => part.type === "text" ? part.text : "").join("\n"));
		if (!item) throw new ToolError("default-fk task router returned no fork result");
		return item;
	};
	let item = await invoke(args.prompt);
	if (item.pending) await reportProgress(`Running agent ${id}...`);
	while (item.pending) {
		await delay(500, undefined, { signal });
		item = await invoke("collect");
	}
	if (typeof item.text !== "string") throw new ToolError(`${route.agent} fork returned no final text`);
	const text = item.text;
	await reportProgress(text, { evalResult: { text, details: { agent: route.agent, id, structured: false } } });
	return text;
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function buildSubagentFailureMessage(agentName: string, result: SingleResult): string {
	const abortReason = trimToUndefined(result.abortReason);
	if (result.aborted && abortReason) return abortReason;
	return (
		trimToUndefined(result.error) ??
		trimToUndefined(result.stderr) ??
		abortReason ??
		`agent() subagent '${agentName}' failed.`
	);
}

async function buildEvalAgentResult(execution: StructuredSubagentResult): Promise<EvalAgentResult> {
	const { result, policy, mergeSummary, changesApplied, artifactsDir } = execution;
	if (result.exitCode !== 0 || result.error || result.aborted) {
		const failureMessage = buildSubagentFailureMessage(policy.agentName, result)
			.replace(/<\/?system-notification>/g, "")
			.trim();
		const recoveryHint = policy.isIsolated ? await buildStructuredSubagentRecoveryHint(result, artifactsDir) : "";
		throw new ToolError(`${failureMessage}${recoveryHint}`);
	}
	if (policy.isIsolated && changesApplied === false) {
		const summary = mergeSummary.replace(/<\/?system-notification>/g, "").trim();
		const recoveryHint = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
		throw new ToolError(
			`agent() isolated apply failed for ${result.id}${summary ? `: ${summary}` : ""}${recoveryHint}`,
		);
	}

	const structuredOutput = result.structuredOutput;
	const structured = structuredOutput?.source !== undefined && structuredOutput.source !== "none";
	if (structured && mergeSummary.includes("<system-notification>")) {
		const recoveryHint = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
		throw new ToolError(
			`agent() isolated nested patch apply failed for ${result.id}: ${mergeSummary.replace(/<\/?system-notification>/g, "").trim()}${recoveryHint}`,
		);
	}

	const hasData = structured && structuredOutput !== undefined && Object.hasOwn(structuredOutput, "data");
	const data = structuredOutput?.data;
	const text = structured ? result.output : result.output + mergeSummary;
	const schemaSource = structuredOutput?.source === "none" ? undefined : structuredOutput?.source;
	const schemaMode = structured ? structuredOutput?.mode : undefined;
	const schemaStatus = structuredOutput?.status === "unavailable" ? undefined : structuredOutput?.status;
	const model = result.resolvedModel ?? policy.modelOverride;
	const nestedPatches = result.nestedPatches?.length ? result.nestedPatches : undefined;
	const isolationSummary = mergeSummary ? mergeSummary.trim() : undefined;
	return {
		text,
		...(hasData ? { data } : {}),
		details: {
			agent: result.agent,
			id: result.id,
			...(model !== undefined ? { model } : {}),
			structured,
			...(schemaSource !== undefined ? { schemaSource } : {}),
			...(schemaMode !== undefined ? { schemaMode } : {}),
			...(schemaStatus !== undefined ? { schemaStatus } : {}),
			...(policy.isIsolated ? { isolated: true, changesApplied } : {}),
			...(result.patchPath !== undefined ? { patchPath: result.patchPath } : {}),
			...(result.hasRootChanges !== undefined ? { hasRootChanges: result.hasRootChanges } : {}),
			...(result.branchName !== undefined ? { branchName: result.branchName } : {}),
			...(nestedPatches !== undefined ? { nestedPatches } : {}),
			...(result.nestedPatchPaths?.length ? { nestedPatchPaths: result.nestedPatchPaths } : {}),
			...(isolationSummary !== undefined ? { isolationSummary } : {}),
		},
	};
}

/** Register a background subagent and return its handle immediately. */
export async function runEvalAgent(args: unknown, options: EvalAgentBridgeOptions): Promise<EvalAgentHandleResult> {
	const parsed = parseAgentArgs(args);
	const forkRoute = evalForkTool(options.session, parsed.agent);
	const turnBudget = options.session.getTurnBudget?.();
	if (turnBudget?.hard && turnBudget.total !== null && turnBudget.spent >= turnBudget.total) {
		throw new ToolError(
			`agent() blocked: turn token budget exhausted (${turnBudget.spent}/${turnBudget.total} output tokens). Raise or drop the +Nk! ceiling to continue.`,
		);
	}
	if (parsed.tools?.length && options.session.getPlanModeState?.()?.enabled === true) {
		throw new ToolError("Eval-defined tools are unavailable in plan mode.");
	}

	const isolation: StructuredSubagentIsolationControls | undefined =
		Object.hasOwn(parsed, "isolated") || Object.hasOwn(parsed, "apply") || Object.hasOwn(parsed, "merge")
			? {
					...(parsed.isolated !== undefined ? { requested: parsed.isolated } : {}),
					...(parsed.merge === false ? { merge: "patch" } : {}),
					...(parsed.apply !== undefined ? { apply: parsed.apply } : {}),
				}
			: undefined;
	const customTools = !forkRoute && parsed.tools?.length
		? createEvalCustomTools(options.session, await describeEvalTools(options.session, parsed.tools, options.signal))
		: undefined;

	try {
		const policy = forkRoute ? { agentName: forkRoute.agent } : await resolveEffectiveSubagentPolicy({
			session: options.session,
			invocationKind: "eval",
			assignment: parsed.prompt,
			...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
			...(Object.hasOwn(parsed, "schema") ? { outputSchema: parsed.schema } : {}),
			...(parsed.schemaMode !== undefined ? { schemaMode: parsed.schemaMode } : {}),
			...(isolation ? { isolation } : {}),
			...(customTools ? { customTools } : {}),
		});
		const manager = options.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("agent() needs the session's async job manager; unavailable here");
		}
		const id = await reserveStructuredSubagentId(options.session, { label: parsed.label });
		const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
		manager.register(
			"task",
			id,
			async ({ signal, reportProgress, markRunning }) => {
				markRunning();
				if (forkRoute) return runEvalFork(parsed, id, forkRoute, reportProgress, signal);
				let latestProgress: AgentProgress | undefined;
				try {
					const execution = await runStructuredSubagent({
						session: options.session,
						invocationKind: "eval",
						assignment: parsed.prompt,
						...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
						...(Object.hasOwn(parsed, "schema") ? { outputSchema: parsed.schema } : {}),
						...(parsed.schemaMode !== undefined ? { schemaMode: parsed.schemaMode } : {}),
						identity: { id, label: parsed.label },
						...(isolation ? { isolation } : {}),
						...(customTools ? { customTools } : {}),
						retainArtifacts: true,
						keepAlive: true,
						shareEvalSession: false,
						signal,
						onProgress: progress => {
							latestProgress = progress;
							void reportProgress(`Running agent ${progress.id}...`, { progress: [progress] });
						},
					});
					const result = await buildEvalAgentResult(execution);
					await reportProgress(result.text, {
						progress: latestProgress ? [latestProgress] : [],
						evalResult: result,
					});
					return result.text;
				} catch (error) {
					if (error instanceof StructuredSubagentError) throw new ToolError(error.message);
					throw error;
				}
			},
			{ id, agentId: id, ownerId },
		);
		return { id, agent: policy.agentName };
	} catch (error) {
		if (error instanceof StructuredSubagentError) throw new ToolError(error.message);
		throw error;
	}
}
