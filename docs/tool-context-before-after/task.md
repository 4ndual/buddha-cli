# task: before and after model-facing description

Baseline: source checkout at HEAD for the previous template, current working tree for the new tool. Conditional settings are fixed by [the generator](../../scripts/generate-tool-context-audit.ts); other profiles can differ. OMP may send this descriptor in the provider tool schema or move it into the system prompt. Neither the TypeScript source nor this audit file is itself sent to the model.

Previous description: **459** tokens. Current description: **459** tokens. Description-only saving: **0** tokens per exposed tool definition. Counted with OMP's Tokenizer strict mode (o200k fallback); provider framing, examples, schema JSON, caching, and billing are excluded.

## Before — rendered from packages/coding-agent/src/prompts/tools/task.md

```text
Run ONE subagent synchronously. Execution blocks until work finishes.

# Task Design
- **Agent typing:** Pick each item's most specific available agent. Omit `agent` when the spawn-policy default is the best fit; otherwise pass the specialist explicitly.
- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.
- **One-pass:** Prefer agents that investigate AND edit in one pass;
- **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge. Name one integration owner and serialize only the irreducibly shared mutation boundary. Every concurrent batch has two prerequisites:
  1. Every task MUST skip validation (build/lint/tests) — validating mid-flight blocks agents on each other's edits.
  2. Decide cross-task contracts up front (e.g. the interface A implements and B consumes) and state them in the task, not left for agents to negotiate.

# Inputs
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. `reviewer`).
  Omitting `agent` selects the spawn-policy default (`task`). Use it only when that agent fits the task.
  NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.

# Communication
Subagents start blank — no conversation history.
Pass large payloads via `local://<path>` URIs, NEVER inline text.

# Format Contracts

`task` format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
Agent spawning is currently disabled.
```

## After — current runtime description

```text
Run ONE subagent synchronously. Execution blocks until work finishes.

# Task Design
- **Agent typing:** Pick each item's most specific available agent. Omit `agent` when the spawn-policy default is the best fit; otherwise pass the specialist explicitly.
- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.
- **One-pass:** Prefer agents that investigate AND edit in one pass;
- **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge. Name one integration owner and serialize only the irreducibly shared mutation boundary. Every concurrent batch has two prerequisites:
  1. Every task MUST skip validation (build/lint/tests) — validating mid-flight blocks agents on each other's edits.
  2. Decide cross-task contracts up front (e.g. the interface A implements and B consumes) and state them in the task, not left for agents to negotiate.

# Inputs
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. `reviewer`).
  Omitting `agent` selects the spawn-policy default (`task`). Use it only when that agent fits the task.
  NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.

# Communication
Subagents start blank — no conversation history.
Pass large payloads via `local://<path>` URIs, NEVER inline text.

# Format Contracts

`task` format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
Agent spawning is currently disabled.
```

## Code contract

The live input contract is `getTaskSchema` in [packages/coding-agent/src/task/index.ts](../../packages/coding-agent/src/task/index.ts); Zod is the runtime parser and JSON Schema source. The schema is separately sent as a tool definition when this tool is active. This tool retains dynamic instructions; the Zod migration did not shorten this description. The result contract is parsed at the tool boundary. This document is a measurement snapshot, not a replacement for executable code.
