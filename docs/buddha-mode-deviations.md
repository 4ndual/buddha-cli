# Buddha mode — historical MVP deviation record

This records the original fork implementation before profile extraction. Paths
and the `buddhaMode` mechanism below are historical. The current architecture is
documented in `docs/buddha-profile-migration.md`: profile-owned runtime and
extensions replaced the static core coupling while preserving these behavioral
decisions.

Status: **all deviations below reviewed and accepted by Andres on 2026-09-09.**

Scope: `buddha-cli` only (dev fork). The `oh-my-pi` prod repo is untouched.

Each entry states what the spec asked for, what was actually built, and the
code-level reason the spec text could not be followed literally. Nothing here is
a scope reduction: every acceptance requirement is still met by another route.

---

## 1. Prompt replacement uses `systemPrompt`, not `--system-prompt`

- **Spec:** "Replace the generated default system prompt only for the root Buddha agent."
- **Built:** `applyBuddhaSessionOptions` sets `options.systemPrompt = () => [BUDDHA_SYSTEM_PROMPT]`
  (`src/buddha/session-overrides.ts`), the function form consumed at `src/sdk.ts:3219-3227`.
- **Why:** the obvious knobs do not produce a minimal prompt. `--system-prompt` /
  `options.customSystemPrompt` route through `prompts/system/custom-system-prompt.md`, and
  `src/system-prompt.ts:1043-1049` then appends `project-prompt.md` (environment, cwd,
  workspace tree, git) unconditionally, plus `computer-safety.md` at `:1035`. Only the
  `systemPrompt` option replaces the rendered blocks wholesale.
- **Prompt text itself is verbatim from the spec** (`src/buddha/prompts.ts`).

## 2. New SDK option `options.buddhaMode`

- **Spec:** no explicit mechanism named.
- **Built:** a boolean marker on `CreateAgentSessionOptions` (`src/sdk.ts:564-571`), consulted by
  the fail-closed provider-context gate (`assertBuddhaProviderContext`, `src/sdk.ts:772-787`).
- **Why:** detecting Buddha mode by reading `settings.get("buddha.enabled")` inside the session
  closures also fires for the **hidden worker subagents**, which inherit the same `Settings`
  instance. Those workers legitimately carry the full tool set, so the assertion would hard-throw
  on every delegated turn. An explicit per-session marker is the only correct discriminator.

## 3. Router model is the configured `task` role, not literally "Luna"

- **Spec:** "Use Luna as the router behind `siddhi()`."
- **Built:** `src/buddha/router.ts` resolves the existing `task` model role rather than hardcoding
  a provider/model, and deliberately adds **no** new settings key.
- **Observed:** on this box `modelRoles.task = anthropic/claude-sonnet-5`, so the router ran as
  Sonnet in all acceptance runs (53 real routing calls).
- **Knob:** set `modelRoles.task: openai-codex/gpt-5.6-luna:low` in `~/.buddha/agent/config.yml`
  to make the router literally Luna. No code change required.

## 4. `metrics.ts` is logger-only; `appendModelUsage` not used

- **Spec:** required instrumentation for Buddha turns, Luna calls and jobs.
- **Built:** all three recorders write structured context to `logger` (`@oh-my-pi/pi-utils`),
  outside any model-visible context. Job state additionally journals to session JSONL `custom`
  entries (`customType: "siddhi_job"`).
- **Why `appendModelUsage` was dropped:** `ModelUsageEntry` (`src/session/session-entries.ts:75-88`)
  requires `api`, `provider`, `model`, `usage`, `stopReason`; none of the three contract shapes
  carries them. Independently, `ToolSession.sessionManager` is a `Pick<...>`
  (`src/tools/index.ts:265-268`) that does **not** expose `appendModelUsage`, so a tool-side call
  is not reachable without widening a shared interface.
- **Consequence:** per-worker token spend is not yet in the `/usage` rollup. Router token counts,
  latency, selected action, and workers started/reused are all in the debug log.

## 5. Print mode needed a new adapter

- **Spec (anticipated this):** "If OMP cannot render a hidden worker result as the root assistant
  response, add the smallest adapter needed."
- **Built:** `src/modes/print-mode.ts` gains a Buddha-gated `irc_message` handler that writes the
  promoted `siddhi-result` answer to stdout, plus `test/print-mode-buddha-answer.test.ts`.
- **Why:** the interactive TUI already renders promoted answers via `#handleIrcMessage`
  (`src/modes/controllers/event-controller.ts:1008`), but non-interactive `-p` printed only
  Buddha's own reply. Proven failure: a `notes.txt` marker request returned "I'm unable to access
  the marker line's text" on stdout while the correct answer sat in the session JSONL.
- **Gated on** `mode === "text" && isBuddhaEnabled(session.settings)`; `--mode json` and ordinary
  print runs are byte-identical to before.

## 6. Deterministic leak rejection added to the router

- **Spec:** "Raw worker output must never be included in `summary`" — stated as a rule.
- **Built:** `containsVerbatimLeak()` (`src/buddha/router.ts:162`) rejects any `finish.summary` or
  `blocked.reason` sharing a 5+ word verbatim run, or an identifier-shaped token, with any worker
  digest. Rejection reuses the existing retry-once path; a second failure degrades to a
  router-authored `blocked`.
- **Why:** prompting was empirically insufficient. A low-effort router echoed the fixture token
  `SECRET_MARKER_7741` from a worker digest straight into `finish.summary`, which then reached
  Buddha's context and printed twice. The thrown message is a fixed string so the leaked text
  cannot ride out through the fallback interpolation.

## 7. `SUBAGENT_WARNING_NULL_YIELD` banners filtered on the Buddha side

- **Observed:** `src/task/executor.ts:691` prepends a null-yield warning banner to worker output,
  so a worker round that yields nothing produces an outcome whose "answer" is just the banner.
  Those were being promoted as if they were answers.
- **Built:** banner-only/empty answers are never promoted and never supersede a real held answer;
  the print renderer also skips banner-only promotions.
- **Not fixed upstream:** `task/executor.ts` is shared by every ordinary session; changing it was
  out of scope for this MVP.

## 8. `RouterInput.reusableWorkers` added to the contract

- **Spec:** "Reuse a worker that already owns the job"; "Do not start a new worker with a full
  fresh context when an existing job can be resumed from stored state."
- **Built:** an optional `reusableWorkers` field on `RouterInput` (`src/buddha/types.ts`), populated
  from prior jobs in the same session, rendered into Luna's compact input, with validation widened
  so `resume|steer|verify|repair` accept a `workerId` from either the current job or that list.
- **Why:** `openOrResumeJob` originally resumed only on a literal `job_<n>` token in the
  instruction. Buddha's minimal prompt does not compel it to quote the id, so every follow-up
  minted a new job with empty `workerIds`, leaving Luna structurally unable to choose anything but
  `start`. Proven by a two-turn run (`/work/qa/t7`): turn 2 spawned a fresh-context worker.
  Resolution order is now: explicit ref → most recent open job → new job. No natural-language
  "is this a continuation?" heuristic was added.

## 8b. Leak handling substitutes a constant instead of throwing

- **Superseded:** the first implementation of §6 threw a `RouterValidationError` on a detected
  leak, reusing the retry-once machinery.
- **Built (final):** a detected leak replaces the offending `finish.summary` / `blocked.reason`
  with a fixed constant. Nothing derived from the leaking text survives, so the isolation
  guarantee is unchanged (strictly, it is stronger — no leaked text can ride out through a retry
  prompt or an error message).
- **Why:** proven by a real run (`/work/qa/t7b`). Identifier-shaped tokens such as `test_area.py`
  are unavoidable in a legitimate control-plane summary, so the check fired on **every** finish.
  The throw converted each finished job into `blocked`, the retry's own failure text became
  `blocked.reason`, and Buddha re-delegated 10+ times — one run produced 10 `blocked` journal
  entries and 5 promotions. Substitution removes the deadlock.

## 9. Promote-once semantics and an explicit stop condition

- **Spec:** the user receives the complete result; Buddha receives only the compact status.
- **Observed defect:** `promoteWorkerAnswer` was called inside the per-round routing loop, so every
  executor/verify/repair round with output promoted another full answer. One prompt produced
  **5 jobs and 8 promotions**.
- **Built:** the answer is promoted exactly once per job (on completion), identical content is
  deduped, and a completed job's summary states the control fact that the full result has already
  been delivered to the user — otherwise Buddha, correctly unable to see the answer, kept
  re-delegating. That phrasing is delegation metadata, not worker content, so the
  "no raw worker output in `summary`" rule still holds.

---

## Historical limitations resolved by profile extraction

1. **Steering envelope.** `convertToLlm` re-applies `wrapSteeringUserMessage`
   (`src/session/messages.ts:1267-1271`), so a steering interjection still reaches Buddha wrapped
   in its envelope. Suppressing it needs a Buddha flag threaded into `messages.ts`, which every
   session shares. Not done.
2. **Import graph coupling (resolved).** `main.ts` now loads only the active
   named profile's `runtime.ts`; Buddha modules live below
   `profiles/buddha-v1/agent/runtime` and cannot break stock startup.
3. **Worker token spend** is not in the `/usage` rollup (see §4).
4. **User-authored worker discovery (resolved).** Discovery uses the active
   configuration directory and the installer imports the allowlisted agent
   definitions into `buddha-v1`.
