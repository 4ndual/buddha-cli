/**
 * The user-visible output path for Buddha mode.
 *
 * A worker's full answer must reach the user without ever entering Buddha's
 * model context. Two halves make that true:
 *   - persistence: `SessionManager.appendCustomMessageEntry` writes the answer
 *     as a `custom_message` entry, and `session-context.ts` excludes
 *     {@link SIDDHI_RESULT_MESSAGE_TYPE} from context rebuilds. Never
 *     `AgentSession.sendCustomMessage` — that also calls `agent.appendMessage`,
 *     which would inject the answer into the live model context.
 *   - live render: `AgentSession.emitIrcRelayObservation` paints the chat
 *     without persisting or touching `agent.state.messages`.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import type { ToolSession } from "../tools";
import { SIDDHI_RESULT_MESSAGE_TYPE, type SiddhiJob } from "./types";

/**
 * Resolve the live root `AgentSession`.
 *
 * `ToolSession` exposes neither `appendCustomMessageEntry`, `saveArtifact`,
 * nor `emitIrcRelayObservation`, so promotion reaches the session through the
 * agent registry — the same accessor `task/workpool.ts`'s card emission uses.
 * Buddha is always the root agent, hence {@link MAIN_AGENT_ID} as the fallback id.
 */
function liveSession(session: ToolSession): AgentSession | undefined {
	const registry = session.agentRegistry ?? AgentRegistry.global();
	const id = session.getAgentId?.() ?? MAIN_AGENT_ID;
	return registry.get(id)?.session ?? registry.get(MAIN_AGENT_ID)?.session ?? undefined;
}

/**
 * Promote a worker's full answer to the user-visible transcript.
 *
 * @returns the durable artifact id and the transcript entry id, when each was written.
 */
export async function promoteWorkerAnswer(
	session: ToolSession,
	job: SiddhiJob,
	answer: string,
): Promise<{ artifactId?: string; entryId?: string }> {
	const live = liveSession(session);
	if (!live) {
		logger.warn("Buddha: cannot promote worker answer, no live session", { job: job.id });
		return {};
	}

	const details = { jobId: job.id };
	let artifactId: string | undefined;
	try {
		artifactId = await live.sessionManager.saveArtifact(answer, "siddhi");
	} catch (error) {
		// Durability is best-effort; the transcript entry below is the primary delivery.
		logger.warn("Buddha: failed to save promoted answer artifact", {
			job: job.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const entryId = live.sessionManager.appendCustomMessageEntry(
		SIDDHI_RESULT_MESSAGE_TYPE,
		answer,
		true,
		artifactId ? { ...details, artifactId } : details,
	);

	const record: CustomMessage = {
		role: "custom",
		customType: SIDDHI_RESULT_MESSAGE_TYPE,
		content: answer,
		display: true,
		details: artifactId ? { ...details, artifactId } : details,
		attribution: "agent",
		timestamp: Date.now(),
	};
	try {
		live.emitIrcRelayObservation(record);
	} catch (error) {
		// Display-only forwarding must never fail the promotion.
		logger.debug("Buddha: promoted answer relay failed", {
			job: job.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return { artifactId, entryId };
}
