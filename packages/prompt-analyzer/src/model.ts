/**
 * Analyzer model resolution.
 *
 * Deviation from RPC-only: model selection happens once per transport, in
 * process, via the OMP SDK's own model-string parser — never hand-parsed.
 * See `parseModelString` (packages/coding-agent/src/config/model-resolver.ts:209),
 * which already strips a trailing `:<thinkingLevel>` suffix via the same
 * internal `splitThinkingSuffix` (:147) the CLI's `--model` flag uses.
 */

import { parseModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

/** Proven working on this box; overridable via `ANALYZER_MODEL`. */
export const DEFAULT_ANALYZER_MODEL = "anthropic/claude-sonnet-5:low";

export interface ResolvedAnalyzerModel {
	/** "provider/id" pattern, thinking suffix already stripped. */
	modelPattern: string;
	/** Configured thinking selector, when the pattern carried one. */
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * Resolves the model used for every stage call: `ANALYZER_MODEL` env var,
 * else {@link DEFAULT_ANALYZER_MODEL}. Throws on a malformed selector rather
 * than silently falling back, since a bad env override should fail loudly at
 * startup, not mid-run.
 */
export function resolveAnalyzerModel(env: NodeJS.ProcessEnv = process.env): ResolvedAnalyzerModel {
	const raw = env.ANALYZER_MODEL?.trim() || DEFAULT_ANALYZER_MODEL;
	const parsed = parseModelString(raw);
	if (!parsed) {
		throw new Error(`ANALYZER_MODEL must look like "provider/model[:thinkingLevel]"; got "${raw}"`);
	}
	return { modelPattern: `${parsed.provider}/${parsed.id}`, thinkingLevel: parsed.thinkingLevel };
}
