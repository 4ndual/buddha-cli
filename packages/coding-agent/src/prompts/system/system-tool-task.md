# task

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 1
- Description: 939
- JSON schema: 131
- Total: 1071

## Description

Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.
Execution does not block — you receive IDs immediately.

# Async Job Contract
- Results auto-deliver. A settled `hub jobs`/`hub wait` snapshot is the delivery; no duplicate `async-result` follows.
- Job IDs are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`.
- With `outputSchema`, a result's parsed payload — when present — is served at `agent://<id>` (fields via `agent://<id>?q=.<field>`) regardless of validity; a schema-violating (invalid) result also previews the payload inline in the auto-delivered follow-up.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.

# Task Design
- **Agent typing:** Pick each item's most specific available agent. Read-only research MUST run on `scout` (faster model). Omit `agent` when the spawn-policy default is the best fit; otherwise pass the specialist explicitly.
- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.
- **One-pass:** Prefer agents that investigate AND edit in one pass; spin a read-only scout only when affected files are genuinely unknown.
- **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge. Have siblings coordinate through `hub` before editing shared files. Name one integration owner and serialize only the irreducibly shared mutation boundary. Every concurrent batch has two prerequisites:
  1. Every task MUST skip validation (build/lint/tests) — validating mid-flight blocks agents on each other's edits.
  2. Decide cross-task contracts up front (e.g. the interface A implements and B consumes) and state them in the batch `context`, not left for agents to negotiate.

# Inputs
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type to spawn (e.g. `scout`, `reviewer`).
    Omitting `agent` selects the spawn-policy default (`task`). Use it only when that agent fits the task.
    NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
  - `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.
  - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
  - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.

# Communication
Subagents start blank — no conversation history. Parent-to-subagent IRC delivered immediately as steering.
Pass large payloads via `local://<path>` URIs, NEVER inline text.

# Format Contracts
`context` format:
# Goal         ← what the batch accomplishes
# Constraints  ← rules and session decisions
# Contract     ← shared interfaces

`task` format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
Pick the most specific agent. Omit `agent` only when the spawn-policy default is that agent.
### scout (READ-ONLY)
MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches. Fast read-only scout returning compressed context for handoff.
Use ONLY for investigation; do edits yourself or assign to a writing agent.

### reviewer
Code review specialist for quality/security analysis
### security-reviewer
Read-only security specialist for evidence-backed repository vulnerability discovery
### task
General-purpose subagent with full capabilities for delegated multi-step tasks
### sonic
Low-reasoning agent for strictly mechanical updates or data collection only

## JSON schema

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "string"
    },
    "tasks": {
      "type": "array",
      "items": {
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
          },
          "tools": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "task"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "context",
    "tasks"
  ],
  "additionalProperties": false
}
```
