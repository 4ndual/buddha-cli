# task: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/task/index.ts). The current task schema includes concurrent uncommitted runtime-tier work. Its token delta is a working-tree snapshot, not an isolated effect of the Zod migration.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 459 | 459 | +0 |
| Provider tool definition (name + description + JSON Schema) | 544 | 595 | -51 |
| Full system-prompt inventory entry | 520 | 550 | -30 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

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

## After: description

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

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "agent": {
      "type": "string",
      "default": "task"
    },
    "outputSchema": {
      "anyOf": [
        {
          "type": "object"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "schemaMode": {
      "enum": [
        "permissive",
        "strict"
      ],
      "type": "string"
    }
  },
  "required": [
    "task"
  ],
  "additionalProperties": false
}
```

## After: input JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string"
    },
    "agent": {
      "default": "task",
      "type": "string"
    },
    "task": {
      "type": "string"
    },
    "rt": {
      "type": "string",
      "enum": [
        "R1",
        "R2",
        "R3",
        "R4",
        "R5"
      ]
    },
    "outputSchema": {
      "anyOf": [
        {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": true
        },
        {
          "type": "boolean"
        },
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "schemaMode": {
      "type": "string",
      "enum": [
        "permissive",
        "strict"
      ]
    }
  },
  "required": [
    "task",
    "rt"
  ]
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Run ONE subagent synchronously. Execution blocks until work finishes.
//
// # Task Design
// - **Agent typing:** Pick each item's most specific available agent. Omit `agent` when the spawn-policy default is the best fit; otherwise pass the specialist explicitly.
// - **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.
// - **One-pass:** Prefer agents that investigate AND edit in one pass;
// - **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge. Name one integration owner and serialize only the irreducibly shared mutation boundary. Every concurrent batch has two prerequisites:
//   1. Every task MUST skip validation (build/lint/tests) — validating mid-flight blocks agents on each other's edits.
//   2. Decide cross-task contracts up front (e.g. the interface A implements and B consumes) and state them in the task, not left for agents to negotiate.
//
// # Inputs
// - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
// - `agent`: The agent type to spawn (e.g. `reviewer`).
//   Omitting `agent` selects the spawn-policy default (`task`). Use it only when that agent fits the task.
//   NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
// - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
// - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
// - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
//
// # Communication
// Subagents start blank — no conversation history.
// Pass large payloads via `local://<path>` URIs, NEVER inline text.
//
// # Format Contracts
//
// `task` format:
// # Target       ← exact files and symbols; explicit non-goals
// # Change       ← step-by-step add/remove/rename; APIs and patterns
// # Acceptance   ← observable result; no project-wide commands
//
// # Available Agents
// Agent spawning is currently disabled.
type task = (_: {
task: string,
name?: string,
agent?: string,
outputSchema?: {} | boolean | string | null,
schemaMode?: "permissive" | "strict",
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Run ONE subagent synchronously. Execution blocks until work finishes.
//
// # Task Design
// - **Agent typing:** Pick each item's most specific available agent. Omit `agent` when the spawn-policy default is the best fit; otherwise pass the specialist explicitly.
// - **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.
// - **One-pass:** Prefer agents that investigate AND edit in one pass;
// - **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge. Name one integration owner and serialize only the irreducibly shared mutation boundary. Every concurrent batch has two prerequisites:
//   1. Every task MUST skip validation (build/lint/tests) — validating mid-flight blocks agents on each other's edits.
//   2. Decide cross-task contracts up front (e.g. the interface A implements and B consumes) and state them in the task, not left for agents to negotiate.
//
// # Inputs
// - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
// - `agent`: The agent type to spawn (e.g. `reviewer`).
//   Omitting `agent` selects the spawn-policy default (`task`). Use it only when that agent fits the task.
//   NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
// - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
// - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
// - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
//
// # Communication
// Subagents start blank — no conversation history.
// Pass large payloads via `local://<path>` URIs, NEVER inline text.
//
// # Format Contracts
//
// `task` format:
// # Target       ← exact files and symbols; explicit non-goals
// # Change       ← step-by-step add/remove/rename; APIs and patterns
// # Acceptance   ← observable result; no project-wide commands
//
// # Available Agents
// Agent spawning is currently disabled.
type task = (_: {
name?: string,
agent?: string,
task: string,
rt: "R1" | "R2" | "R3" | "R4" | "R5",
outputSchema?: Record<string, unknown> | boolean | string | null,
schemaMode?: "permissive" | "strict",
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
