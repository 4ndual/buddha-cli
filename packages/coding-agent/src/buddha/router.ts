/**
 * Luna router: converts a natural-language siddhi instruction plus compact
 * job state into exactly one validated {@link RouterAction} via a single
 * bounded one-shot model call.
 *
 * The provider request's ENTIRE system prompt is {@link LUNA_ROUTER_PROMPT}
 * (verbatim) — no OMP system prompt, no tool schemas, no transcripts. Luna
 * itself carries no tools; it only ever emits the next runtime action.
 */
import { type AssistantMessage, completeSimple, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { ToolSession } from "../tools";

import { recordLunaCall } from "./metrics";
import { LUNA_ROUTER_PROMPT } from "./prompts";
import { clampSummary, type RouterAction, type RouterInput, type SiddhiJob, type WorkerOutcome } from "./types";

/**
 * Compact worker-capability registry visible to Luna. Names + one-line
 * descriptions only — no schemas, no skill lists. Every ordinary OMP
 * subagent implements all four modes; these are routing labels, not
 * distinct implementations.
 */
export const WORKER_CAPABILITIES: readonly { name: string; description: string }[] = [
	{ name: "executor", description: "Performs the requested work, or answers the question, from scratch." },
	{ name: "verifier", description: "Independently checks completion when evidence of doneness is needed." },
	{ name: "repairer", description: "Repairs the exact defect a verifier reported, nothing more." },
	{ name: "integrator", description: "Combines multiple independently produced artifacts into one result." },
];

/** Per-outcome digest cap inside the rendered router input. */
const MAX_OUTCOME_DIGEST_CHARS = 600;
/** Hard cap on the entire rendered router input. Oldest outcomes drop first past this budget. */
const MAX_RENDERED_INPUT_CHARS = 4000;
/** Router turns are single classification-style decisions; keep the output budget tight. */
const ROUTER_MAX_TOKENS = 2048;

/**
 * Action grammar for the router turn. {@link LUNA_ROUTER_PROMPT} is a frozen
 * contract and `completeSimple` exposes no response schema, so the JSON-only
 * output instruction rides in the rendered input instead. It is always the
 * last thing the router reads and is never dropped by the char budget.
 */
const ROUTER_OUTPUT_CONTRACT = [
	"Reply with one JSON object and nothing else. Exactly one of:",
	'{"action":"start","workerType":"<capability name>","instruction":"<what the worker must do>","doneWhen":["<proof of completion>"]}',
	'{"action":"resume"|"steer"|"verify"|"repair","workerId":"<one of job.workerIds or of the reusable workers>","instruction":"<what to do next>"}',
	'{"action":"finish","summary":"<control-plane summary>","userResultRef":"<ref of the user-facing result>"}',
	'{"action":"blocked","reason":"<why the request cannot proceed>"}',
	"State summary/reason in your own words as control-plane facts. Never quote worker digests verbatim — the user already receives the worker's full answer separately.",
].join("\n");

/** Budget left for the variable part of the render once the output contract is reserved. */
const MAX_VARIABLE_INPUT_CHARS = MAX_RENDERED_INPUT_CHARS - ROUTER_OUTPUT_CONTRACT.length - 2;

function renderOutcome(outcome: WorkerOutcome): string {
	const lines = [
		`- workerId=${outcome.workerId} mode=${outcome.mode} failed=${outcome.failed}`,
		`  digest: ${clampSummary(outcome.digest, MAX_OUTCOME_DIGEST_CHARS)}`,
	];
	if (outcome.artifactRefs.length > 0) lines.push(`  artifacts: ${outcome.artifactRefs.join(", ")}`);
	return lines.join("\n");
}

function renderReusableWorker(entry: NonNullable<RouterInput["reusableWorkers"]>[number]): string {
	return `- workerId=${entry.workerId} mode=${entry.mode} fromJob=${entry.jobId}: ${clampSummary(entry.digest, MAX_OUTCOME_DIGEST_CHARS)}`;
}

/**
 * Render `input` into the router's entire user message: instruction, compact
 * job record, capability registry, reusable workers from this session's
 * earlier jobs, and compact worker outcomes. Never includes full transcripts,
 * raw command/tool output, tool schemas, or file contents — only the fields
 * already present on {@link RouterInput}.
 *
 * Capped at {@link MAX_RENDERED_INPUT_CHARS} total, of which the trailing
 * {@link ROUTER_OUTPUT_CONTRACT} is reserved. `input.outcomes` is
 * chronological (oldest first) and `input.reusableWorkers` is most-recent
 * first; both are dropped oldest-first — reusable workers before this job's
 * own outcomes — until the remainder fits, then the variable part is
 * truncated as a hard backstop.
 */
function renderRouterInput(input: RouterInput): string {
	const job = input.job;
	const header = [
		`instruction: ${input.instruction}`,
		`job.status: ${job.status}`,
		`job.outcome: ${job.outcome}`,
		`job.constraints: ${job.constraints.join("; ") || "(none)"}`,
		`job.doneWhen: ${job.doneWhen.join("; ") || "(none)"}`,
		`job.workerIds: ${job.workerIds.join(", ") || "(none)"}`,
		`job.artifactRefs: ${job.artifactRefs.join(", ") || "(none)"}`,
		`job.evidenceRefs: ${job.evidenceRefs.join(", ") || "(none)"}`,
		`job.assumptions: ${job.assumptions.join("; ") || "(none)"}`,
		`job.lastSummary: ${job.lastSummary || "(none)"}`,
		"",
		"capabilities:",
		...input.capabilities.map(capability => `- ${capability.name}: ${capability.description}`),
	].join("\n");

	const reusableEntries = input.reusableWorkers ?? [];
	const reusableLines = reusableEntries.map(renderReusableWorker);
	const outcomeLines = input.outcomes.map(renderOutcome);
	let reusableDropped = 0;
	let outcomesDropped = 0;
	// Reserve room for each section's header and its join newlines.
	const overBudget = (): boolean =>
		header.length +
			(reusableLines.length > 0 ? reusableLines.join("\n").length + 64 : 0) +
			outcomeLines.join("\n").length +
			64 >
		MAX_VARIABLE_INPUT_CHARS;
	// Cross-job reuse candidates are an offer, not this job's own history:
	// drop them first, oldest-first, before touching the job's outcomes.
	while (reusableLines.length > 0 && overBudget()) {
		reusableLines.pop();
		reusableDropped++;
	}
	while (outcomeLines.length > 0 && overBudget()) {
		outcomeLines.shift();
		outcomesDropped++;
	}

	const reusableSection =
		reusableEntries.length === 0
			? undefined
			: [
					reusableDropped > 0
						? `reusable workers from earlier jobs in this session (oldest ${reusableDropped} dropped for budget):`
						: "reusable workers from earlier jobs in this session:",
					...reusableLines,
				].join("\n");

	const outcomesHeader =
		input.outcomes.length === 0
			? "worker outcomes: (none)"
			: outcomesDropped > 0
				? `worker outcomes (oldest ${outcomesDropped} dropped for budget):`
				: "worker outcomes:";
	const outcomesSection = outcomeLines.length > 0 ? `${outcomesHeader}\n${outcomeLines.join("\n")}` : outcomesHeader;

	const variable = [header, reusableSection, outcomesSection]
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
	const capped =
		variable.length <= MAX_VARIABLE_INPUT_CHARS ? variable : `${variable.slice(0, MAX_VARIABLE_INPUT_CHARS - 1)}…`;
	return `${capped}\n\n${ROUTER_OUTPUT_CONTRACT}`;
}

/** Thrown for any router output that fails schema validation; message doubles as retry feedback. */
class RouterValidationError extends Error {}

function parseRouterJson(raw: string): unknown {
	const text = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new RouterValidationError(
			`router output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === "string");
}

/** Minimum contiguous word run shared verbatim with a source before it counts as lifted prose. */
const MIN_LEAK_PHRASE_WORDS = 5;
/** Minimum length of an identifier-shaped token (digit/underscore/hyphen/ALL-CAPS) before a verbatim match counts as a leaked marker/id/secret. */
const MIN_LEAK_TOKEN_CHARS = 6;

function looksLikeIdentifier(token: string): boolean {
	const stripped = token.replace(/^[^\w]+|[^\w]+$/g, "");
	if (stripped.length < MIN_LEAK_TOKEN_CHARS) return false;
	return /\d/.test(stripped) || stripped.includes("_") || stripped.includes("-") || /^[A-Z0-9_]+$/.test(stripped);
}

/**
 * True when `text` — a router-authored string that is about to become
 * Buddha-visible (`finish.summary` / `blocked.reason`) — contains either a
 * {@link MIN_LEAK_PHRASE_WORDS}-word verbatim run or an identifier-shaped
 * token that also appears verbatim in `sources` (worker digests). Signals
 * Luna quoted raw worker output instead of writing its own control-plane
 * text. Deliberately returns a bare boolean, never the matched substring:
 * the caller's error message must stay leak-free even when this fires,
 * because that message can itself reach Buddha's context after a failed
 * retry (see the `blocked` fallback in {@link routeNext}).
 */
function containsVerbatimLeak(text: string, sources: readonly string[]): boolean {
	const sourceTexts = sources.filter(source => source.length > 0);
	if (sourceTexts.length === 0) return false;
	const textWords = text.split(/\s+/).filter(word => word.length > 0);
	for (const word of textWords) {
		const stripped = word.replace(/^[^\w]+|[^\w]+$/g, "");
		if (looksLikeIdentifier(stripped) && sourceTexts.some(source => source.includes(stripped))) return true;
	}
	for (let start = 0; start <= textWords.length - MIN_LEAK_PHRASE_WORDS; start++) {
		const run = textWords.slice(start, start + MIN_LEAK_PHRASE_WORDS).join(" ");
		if (sourceTexts.some(source => source.includes(run))) return true;
	}
	return false;
}

/**
 * Fixed stand-ins for a router-authored string that quoted worker output.
 * Never derived from the offending text, so nothing of the leak survives.
 *
 * A leak must never fail the turn: throwing turned a *finished* job into
 * `blocked`, and the retry's own failure text then became `blocked.reason`,
 * so Buddha re-delegated the same completed work round after round.
 * Substituting keeps the isolation guarantee absolutely and still settles.
 */
const LEAKED_SUMMARY_REPLACEMENT =
	"Work finished. Details withheld: the full result went to the user, not to this summary.";
const LEAKED_REASON_REPLACEMENT = "Cannot proceed. Details withheld: the explanation repeated worker output.";

/**
 * Validate a parsed router response against the {@link RouterAction}
 * discriminated union and the worker ids the router was actually offered:
 * the job's own `workerIds` plus any cross-job `reusableWorkers` rendered
 * this round. Throws {@link RouterValidationError} — never returns a
 * partially-valid action.
 */
function validateRouterAction(
	parsed: unknown,
	job: SiddhiJob,
	outcomes: readonly WorkerOutcome[],
	reusableWorkers: NonNullable<RouterInput["reusableWorkers"]> = [],
): RouterAction {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new RouterValidationError("router output must be a JSON object");
	}
	const obj = parsed as Record<string, unknown>;
	const action = obj.action;

	switch (action) {
		case "start": {
			const workerType = obj.workerType;
			const instruction = obj.instruction;
			const doneWhen = obj.doneWhen;
			if (
				typeof workerType !== "string" ||
				!WORKER_CAPABILITIES.some(capability => capability.name === workerType)
			) {
				throw new RouterValidationError(
					`"start" requires workerType to be one of ${WORKER_CAPABILITIES.map(capability => capability.name).join(", ")}, got ${JSON.stringify(workerType)}`,
				);
			}
			if (typeof instruction !== "string" || instruction.trim().length === 0) {
				throw new RouterValidationError('"start" requires a non-empty instruction');
			}
			if (!isNonEmptyStringArray(doneWhen)) {
				throw new RouterValidationError('"start" requires a non-empty doneWhen string array');
			}
			return { action: "start", workerType, instruction, doneWhen };
		}
		case "resume":
		case "steer":
		case "verify":
		case "repair": {
			const workerId = obj.workerId;
			const instruction = obj.instruction;
			// A worker from an earlier job in this session is a legitimate
			// continuation target: it is live/parked and owns the relevant state.
			const knownWorkerIds = [
				...job.workerIds,
				...reusableWorkers.map(entry => entry.workerId).filter(id => !job.workerIds.includes(id)),
			];
			if (typeof workerId !== "string" || !knownWorkerIds.includes(workerId)) {
				throw new RouterValidationError(
					`"${action}" requires workerId to be one of the known worker ids (${knownWorkerIds.join(", ") || "none yet"}), got ${JSON.stringify(workerId)}`,
				);
			}
			if (typeof instruction !== "string" || instruction.trim().length === 0) {
				throw new RouterValidationError(`"${action}" requires a non-empty instruction`);
			}
			return { action: action as "resume" | "steer" | "verify" | "repair", workerId, instruction };
		}
		case "finish": {
			const summary = obj.summary;
			const userResultRef = obj.userResultRef;
			if (typeof summary !== "string" || summary.trim().length === 0) {
				throw new RouterValidationError('"finish" requires a non-empty summary');
			}
			if (typeof userResultRef !== "string" || userResultRef.trim().length === 0) {
				throw new RouterValidationError('"finish" requires a non-empty userResultRef');
			}
			const digests = outcomes.map(outcome => outcome.digest);
			return {
				action: "finish",
				summary: containsVerbatimLeak(summary, digests) ? LEAKED_SUMMARY_REPLACEMENT : summary,
				userResultRef,
			};
		}
		case "blocked": {
			const reason = obj.reason;
			if (typeof reason !== "string" || reason.trim().length === 0) {
				throw new RouterValidationError('"blocked" requires a non-empty reason');
			}
			return {
				action: "blocked",
				reason: containsVerbatimLeak(
					reason,
					outcomes.map(outcome => outcome.digest),
				)
					? LEAKED_REASON_REPLACEMENT
					: reason,
			};
		}
		default:
			throw new RouterValidationError(
				`"action" must be one of start|resume|steer|verify|repair|finish|blocked, got ${JSON.stringify(action)}`,
			);
	}
}

interface RouterCallResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

/**
 * One provider call: system prompt is exactly {@link LUNA_ROUTER_PROMPT},
 * user message is `userMessage`. Falls back to a local {@link Tokenizer}
 * estimate when the provider doesn't report usage.
 */
async function callRouterModel(
	model: Model,
	registry: ModelRegistry,
	sessionId: string | undefined,
	tokenizer: Tokenizer,
	userMessage: string,
	signal: AbortSignal | undefined,
): Promise<RouterCallResult> {
	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: [LUNA_ROUTER_PROMPT],
					messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
				},
				{
					apiKey: registry.resolver(model, sessionId),
					sessionId,
					maxTokens: ROUTER_MAX_TOKENS,
					disableReasoning: true,
					signal,
				},
			),
		{ signal },
	);
	if (response.stopReason === "error") {
		throw new Error(`model call failed: ${response.errorMessage ?? "unknown error"}`);
	}
	const text = response.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
	return {
		text,
		inputTokens: response.usage?.input ?? tokenizer.countTokens([LUNA_ROUTER_PROMPT, userMessage]),
		outputTokens: response.usage?.output ?? tokenizer.countTokens(text),
	};
}

/**
 * Route the next runtime action for a siddhi job. Exactly one model call, or
 * two when the first response fails validation (the second is fed the
 * validation error as feedback). Always resolves to a valid
 * {@link RouterAction} — including `blocked` for router-side failures — and
 * never throws into Buddha's context.
 *
 * Model selection prefers the dedicated `delegator` role, falling back to
 * `task` when `delegator` is unconfigured ({@link resolveRoleSelection} tries
 * each role in order and returns the first with both a configured value and
 * an available model). A dedicated role exists because this call is a 22
 * token in / 14 token out JSON routing decision: reusing `task` meant it
 * silently inherited whatever frontier model that role resolved to
 * (`anthropic/claude-sonnet-5:medium` measured on this box), doubling
 * Buddha mode's per-job wall-time overhead for a call that needs none of
 * that model's capability.
 */
export async function routeNext(
	input: RouterInput,
	ctx: { session: ToolSession; signal?: AbortSignal },
): Promise<RouterAction> {
	const startedAt = Date.now();
	const job = input.job;
	let modelLabel = "(unresolved)";
	let retried = false;

	const settle = (action: RouterAction, inputTokens: number, outputTokens: number): RouterAction => {
		const latencyMs = Date.now() - startedAt;
		const workersStarted = action.action === "start" ? 1 : 0;
		const workersReused =
			action.action === "resume" ||
			action.action === "steer" ||
			action.action === "verify" ||
			action.action === "repair"
				? 1
				: 0;
		// Distinct from the identical-topic line in `recordLunaCall`: this one
		// carries what the metrics sink never receives — which model answered
		// and whether the validation retry was spent.
		logger.debug("buddha: luna router call", {
			action: action.action,
			model: modelLabel,
			retried,
			inputTokens,
			outputTokens,
			latencyMs,
			workersStarted,
			workersReused,
		});
		recordLunaCall(ctx.session, {
			inputTokens,
			outputTokens,
			latencyMs,
			action: action.action,
			workersStarted,
			workersReused,
		});
		return action;
	};

	const registry = ctx.session.modelRegistry;
	if (!registry) return settle({ action: "blocked", reason: "luna router: session has no model registry" }, 0, 0);

	const resolved = resolveRoleSelection(["delegator", "task"], ctx.session.settings, registry.getAvailable());
	if (!resolved) {
		return settle(
			{ action: "blocked", reason: 'luna router: no model resolved for the "delegator" or "task" role' },
			0,
			0,
		);
	}
	const { model } = resolved;
	modelLabel = `${model.provider}/${model.id}`;
	const tokenizer = new Tokenizer(model);
	const sessionId = ctx.session.sessionManager?.getSessionId?.();
	const renderedInput = renderRouterInput(input);

	try {
		const apiKey = await registry.getApiKey(model, sessionId, { signal: ctx.signal });
		if (!apiKey) {
			return settle(
				{ action: "blocked", reason: `luna router: no API key for ${model.provider}/${model.id}` },
				tokenizer.countTokens(renderedInput),
				0,
			);
		}

		const first = await callRouterModel(model, registry, sessionId, tokenizer, renderedInput, ctx.signal);
		let totalInputTokens = first.inputTokens;
		let totalOutputTokens = first.outputTokens;
		try {
			const action = validateRouterAction(parseRouterJson(first.text), job, input.outcomes, input.reusableWorkers);
			return settle(action, totalInputTokens, totalOutputTokens);
		} catch (firstError) {
			retried = true;
			const errorText = firstError instanceof Error ? firstError.message : String(firstError);
			const retryMessage = `${renderedInput}\n\nYour previous response was invalid: ${errorText}\nReturn ONLY corrected JSON for the next runtime action.`;
			const retry = await callRouterModel(model, registry, sessionId, tokenizer, retryMessage, ctx.signal);
			totalInputTokens += retry.inputTokens;
			totalOutputTokens += retry.outputTokens;
			try {
				const action = validateRouterAction(
					parseRouterJson(retry.text),
					job,
					input.outcomes,
					input.reusableWorkers,
				);
				return settle(action, totalInputTokens, totalOutputTokens);
			} catch (secondError) {
				const secondText = secondError instanceof Error ? secondError.message : String(secondError);
				return settle(
					{ action: "blocked", reason: `luna router: invalid output after retry: ${secondText}` },
					totalInputTokens,
					totalOutputTokens,
				);
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.debug("buddha: luna router call failed", { error: message });
		return settle({ action: "blocked", reason: `luna router: ${message}` }, tokenizer.countTokens(renderedInput), 0);
	}
}
