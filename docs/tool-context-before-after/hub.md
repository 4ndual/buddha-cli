# hub: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/tools/hub/index.ts). The descriptors and schemas were read from instantiated tools in isolated source checkouts.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 1237 | 266 | +971 |
| Provider tool definition (name + description + JSON Schema) | 2150 | 734 | +1416 |
| Full system-prompt inventory entry | 2265 | 917 | +1348 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

```text
Agent coordination: peer messaging, background-job control, and supervised long-running processes. Main agent is `Main`; subagents inherit task ID.
Use `op: "list"` to discover live peers. Default is running+idle plus running/idle/parked/shown/truncated counts — never an unbounded parked name dump. Pass `status: "parked"` for parked archaeology; optional `limit` bounds rows (default 32, max 100). Address peers by exact roster ID — NEVER invent names. `send` to a known parked id still revives it; `history://<id>` and `agent://<id>` stay readable.

# Messaging & Jobs

Background jobs auto-deliver when they finish. You NEVER need to poll; if `jobs`/`wait` observes a settled job first, that snapshot is the delivery and suppresses duplicate `async-result`.

- **The user is NOT a peer.** `Main` answers the user ONLY in a plain text block; a `send` shows them a tool-card preview (2 lines while collapsed). Thinking is not output either.
- **`send`** (with `to`): fire-and-forget, NEVER blocks. Delivery receipts (`delivered`/`failed`) immediate; `failed` → peer gone, don't retry.
  Sending wakes `idle`/`parked` peers. Answering: lead with answer, NEVER quote, set `replyTo`.
- **Format**: plain prose ONLY. No JSON status objects. Share paths via `local://`/`artifact://` URLs, not pasted blobs.
- **`wait`**: use ONLY when completely blocked with no other work. Returns on the FIRST of: an incoming message, a watched job finishing, the wait window elapsing, or a steering interrupt — NOT when all jobs finish; re-issue to keep waiting.
  - Bare `wait` watches every running job AND incoming messages. NEVER pass an array of every running ID; `ids` narrows to specific jobs, `from` to one peer (or use `await: true` on send).
  - A **user** message arriving as steering is not a wake reason to poll past: answer it in a text block BEFORE re-issuing `wait`. Parent/peer steering is answered with `send`; advisor and budget steers need no reply.
- **`inbox`**: drain queued messages without blocking.
- **`cancel`**: kill background jobs by `ids` when they have hung, stalled, or are no longer needed. Returns immediately.
- **`jobs`**: status snapshot of every job without waiting. A settled row consumes auto-delivery. Also names running subagents with no job entry — coordinate with those via `send`.
- Job rows are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `send`, `agent://<id>`, or `history://<id>`.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
- NEVER use shell tools, grep, or read other sessions' files to figure out what a peer is doing. Message them directly.
- NEVER use hub messaging for something a tool can answer (e.g., grepping codebase, running a build).

# Processes

Project-scoped long-running processes shared by every omp instance in the same directory. A long-running service, watcher, debugger, REPL, or process needing later input MUST use `op:"start"`, not `bash`.

- **`start`** launches `application` + `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
  - `ready.log` is a JavaScript `RegExp` compiled with the `u` flag; PCRE inline modifiers such as `(?i)` are REJECTED — use `[Rr]eady` instead. `ready.port` is a TCP port. Both supplied? BOTH MUST pass. `ready.timeout` is seconds. Readiness MUST be observed; process creation alone is not readiness.
  - Names are unique per project directory. A completed name MAY be started again; a live name MUST be stopped or restarted.
  - `restart` policy defaults `no`; `on-failure` and `always` use bounded backoff.
  - `persist: true` opts out of last-omp teardown; `detached: true` survives broker shutdown and all omp exits (implies persist, disables PTY input). Omit both unless their survival guarantees are required.
- **`ps`**, **`logs`**, **`wait`** (with `name`), **`send`** (with `name`), **`stop`**, **`restart`**, and **`describe`** address the stable `name`.
- **`logs`** defaults to the last 100 lines. `head: true` reads the beginning. `grep` is a JavaScript `RegExp` compiled with the `u` flag (no inline modifiers such as `(?i)`). `follow: true` waits for output after `cursor`; reuse the returned cursor on the next call.
- **`wait`** with `name` blocks until readiness/exit/`pattern` or `timeout` (seconds). `pattern` is a JavaScript `RegExp` compiled with the `u` flag (no inline modifiers such as `(?i)`).
- **`send`** with `name`: `text` writes stdin (`enter` defaults true); `keys` supports ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT; `signal` supports SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGKILL. PTY input is serialized; writes share one input stream.
- **`stop`** performs graceful process-tree termination before hard-kill; NEVER kill an unverified PID through bash. **`restart`** reuses the retained launch spec.
```

## After: description

```text
Coordinate peers, background jobs, and project-scoped processes. The user is not a peer; Main answers in normal text. list discovers exact peer IDs (running/idle by default; status:'parked' for history). send({to,message}) wakes known peers; await:true waits for one reply (not with to:'all'); replyTo answers a message. inbox drains queued messages. Use paths, not pasted blobs. Do not message peers for facts tools can obtain. Jobs auto-deliver on completion. jobs snapshots; cancel({ids}) stops jobs. wait only when blocked: returns on the first matching message, job settlement, timeout, or interrupt; ids/from narrow it. User steering needs a text answer before another wait. Long-running services/watchers/REPLs use start({name,application,args,ready}), not bash. Readiness requires the supplied log/port checks, not mere process creation. ps/logs/wait/send/stop/restart/describe with name operate on that process. logs follow uses cursor; patterns are JS RegExp with u, not PCRE inline modifiers. stop is graceful before hard kill. persist survives the last OMP client; detached survives broker exit and disables PTY input. Omit unless needed. A settled job or process exit is not proof its artifact is accepted.
```

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "op": {
      "enum": [
        "send",
        "wait",
        "inbox",
        "list",
        "jobs",
        "cancel",
        "start",
        "ps",
        "logs",
        "stop",
        "restart",
        "describe"
      ],
      "type": "string",
      "description": "hub operation"
    },
    "to": {
      "type": "string",
      "description": "send: recipient agent id or \"all\""
    },
    "message": {
      "type": "string",
      "description": "send: message body"
    },
    "replyTo": {
      "type": "string",
      "description": "send: message id being answered"
    },
    "await": {
      "type": "boolean",
      "description": "send: wait for the recipient's reply (invalid with to:\"all\")"
    },
    "from": {
      "type": "string",
      "description": "wait: only accept a message from this agent id"
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "wait: job ids to watch (omit = all running jobs); cancel: job ids to kill"
    },
    "timeoutMs": {
      "type": "number",
      "description": "wait (messages/jobs): timeout in milliseconds (0 waits indefinitely)"
    },
    "peek": {
      "type": "boolean",
      "description": "inbox: list messages without consuming them"
    },
    "status": {
      "enum": [
        "running",
        "idle",
        "parked"
      ],
      "type": "string",
      "description": "list: filter by status; omit for running+idle"
    },
    "limit": {
      "type": "number",
      "exclusiveMinimum": 0,
      "description": "list: max peer rows; default 32, max 100"
    },
    "name": {
      "type": "string",
      "maxLength": 48,
      "description": "process ops: stable project-scoped launch name"
    },
    "application": {
      "type": "string",
      "minLength": 1,
      "description": "start: executable or application path"
    },
    "args": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "start: argv passed directly to the application"
    },
    "env": {
      "type": "object",
      "properties": {},
      "additionalProperties": {
        "type": "string"
      },
      "description": "start: extra environment variables"
    },
    "cwd": {
      "type": "string",
      "description": "start: working directory; defaults to the session directory"
    },
    "pty": {
      "type": "boolean",
      "description": "start: allocate an interactive PTY; default true"
    },
    "ready": {
      "type": "object",
      "properties": {
        "log": {
          "type": "string",
          "minLength": 1,
          "description": "regex matched against output"
        },
        "port": {
          "type": "number",
          "description": "TCP port that must accept connections"
        },
        "host": {
          "type": "string",
          "minLength": 1,
          "description": "TCP readiness host; default 127.0.0.1"
        },
        "timeout": {
          "type": "number",
          "exclusiveMinimum": 0,
          "description": "seconds to wait; default 30"
        }
      },
      "description": "start: readiness conditions; all supplied conditions must pass",
      "additionalProperties": false
    },
    "restart": {
      "enum": [
        "no",
        "on-failure",
        "always"
      ],
      "type": "string",
      "description": "start: restart policy; default no"
    },
    "persist": {
      "type": "boolean",
      "description": "start: survive the last omp client exiting; default false"
    },
    "detached": {
      "type": "boolean",
      "description": "start: survive every omp and broker exit; implies persist and disables PTY input"
    },
    "lines": {
      "type": "number",
      "exclusiveMinimum": 0,
      "description": "logs: output lines; default 100, max 1000"
    },
    "head": {
      "type": "boolean",
      "description": "logs: read from the beginning instead of the tail"
    },
    "grep": {
      "type": "string",
      "minLength": 1,
      "description": "logs: regex filter"
    },
    "follow": {
      "type": "boolean",
      "description": "logs: wait for output newer than cursor"
    },
    "cursor": {
      "type": "number",
      "minimum": 0,
      "description": "logs: output cursor returned by an earlier call"
    },
    "for": {
      "enum": [
        "ready",
        "exit"
      ],
      "type": "string",
      "description": "wait with name: lifecycle condition; default exit"
    },
    "pattern": {
      "type": "string",
      "minLength": 1,
      "description": "wait with name: output regex; takes precedence over for"
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "description": "send with name: stdin text"
    },
    "enter": {
      "type": "boolean",
      "description": "send with name: append Enter after text; default true"
    },
    "keys": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "send with name: terminal keys after text"
    },
    "signal": {
      "enum": [
        "SIGINT",
        "SIGTERM",
        "SIGHUP",
        "SIGQUIT",
        "SIGKILL"
      ],
      "type": "string",
      "description": "send with name: process-tree signal"
    },
    "timeout": {
      "type": "number",
      "exclusiveMinimum": 0,
      "description": "logs/stop/wait with name: max seconds; default 30 (stop: 5)"
    }
  },
  "required": [
    "op"
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
    "op": {
      "type": "string",
      "enum": [
        "send",
        "wait",
        "inbox",
        "list",
        "jobs",
        "cancel",
        "start",
        "ps",
        "logs",
        "stop",
        "restart",
        "describe"
      ]
    },
    "to": {
      "type": "string"
    },
    "message": {
      "type": "string"
    },
    "replyTo": {
      "type": "string"
    },
    "await": {
      "type": "boolean"
    },
    "from": {
      "type": "string"
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "timeoutMs": {
      "type": "number"
    },
    "peek": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "running",
        "idle",
        "parked"
      ]
    },
    "limit": {
      "description": "Clamped to 100; defaults to 32",
      "type": "number",
      "exclusiveMinimum": 0
    },
    "name": {
      "type": "string",
      "maxLength": 48
    },
    "application": {
      "type": "string",
      "minLength": 1
    },
    "args": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "env": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "cwd": {
      "type": "string"
    },
    "pty": {
      "type": "boolean"
    },
    "ready": {
      "type": "object",
      "properties": {
        "log": {
          "type": "string",
          "minLength": 1
        },
        "port": {
          "type": "number"
        },
        "host": {
          "type": "string",
          "minLength": 1
        },
        "timeout": {
          "type": "number",
          "exclusiveMinimum": 0
        }
      }
    },
    "restart": {
      "type": "string",
      "enum": [
        "no",
        "on-failure",
        "always"
      ]
    },
    "persist": {
      "type": "boolean"
    },
    "detached": {
      "type": "boolean"
    },
    "lines": {
      "description": "Clamped to 1000",
      "type": "number",
      "exclusiveMinimum": 0
    },
    "head": {
      "type": "boolean"
    },
    "grep": {
      "type": "string",
      "minLength": 1
    },
    "follow": {
      "type": "boolean"
    },
    "cursor": {
      "type": "number",
      "minimum": 0
    },
    "for": {
      "type": "string",
      "enum": [
        "ready",
        "exit"
      ]
    },
    "pattern": {
      "type": "string",
      "minLength": 1
    },
    "text": {
      "type": "string",
      "minLength": 1
    },
    "enter": {
      "type": "boolean"
    },
    "keys": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "signal": {
      "type": "string",
      "enum": [
        "SIGINT",
        "SIGTERM",
        "SIGHUP",
        "SIGQUIT",
        "SIGKILL"
      ]
    },
    "timeout": {
      "type": "number",
      "exclusiveMinimum": 0
    }
  },
  "required": [
    "op"
  ]
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Agent coordination: peer messaging, background-job control, and supervised long-running processes. Main agent is `Main`; subagents inherit task ID.
// Use `op: "list"` to discover live peers. Default is running+idle plus running/idle/parked/shown/truncated counts — never an unbounded parked name dump. Pass `status: "parked"` for parked archaeology; optional `limit` bounds rows (default 32, max 100). Address peers by exact roster ID — NEVER invent names. `send` to a known parked id still revives it; `history://<id>` and `agent://<id>` stay readable.
//
// # Messaging & Jobs
//
// Background jobs auto-deliver when they finish. You NEVER need to poll; if `jobs`/`wait` observes a settled job first, that snapshot is the delivery and suppresses duplicate `async-result`.
//
// - **The user is NOT a peer.** `Main` answers the user ONLY in a plain text block; a `send` shows them a tool-card preview (2 lines while collapsed). Thinking is not output either.
// - **`send`** (with `to`): fire-and-forget, NEVER blocks. Delivery receipts (`delivered`/`failed`) immediate; `failed` → peer gone, don't retry.
//   Sending wakes `idle`/`parked` peers. Answering: lead with answer, NEVER quote, set `replyTo`.
// - **Format**: plain prose ONLY. No JSON status objects. Share paths via `local://`/`artifact://` URLs, not pasted blobs.
// - **`wait`**: use ONLY when completely blocked with no other work. Returns on the FIRST of: an incoming message, a watched job finishing, the wait window elapsing, or a steering interrupt — NOT when all jobs finish; re-issue to keep waiting.
//   - Bare `wait` watches every running job AND incoming messages. NEVER pass an array of every running ID; `ids` narrows to specific jobs, `from` to one peer (or use `await: true` on send).
//   - A **user** message arriving as steering is not a wake reason to poll past: answer it in a text block BEFORE re-issuing `wait`. Parent/peer steering is answered with `send`; advisor and budget steers need no reply.
// - **`inbox`**: drain queued messages without blocking.
// - **`cancel`**: kill background jobs by `ids` when they have hung, stalled, or are no longer needed. Returns immediately.
// - **`jobs`**: status snapshot of every job without waiting. A settled row consumes auto-delivery. Also names running subagents with no job entry — coordinate with those via `send`.
// - Job rows are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `send`, `agent://<id>`, or `history://<id>`.
// - `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
// - NEVER use shell tools, grep, or read other sessions' files to figure out what a peer is doing. Message them directly.
// - NEVER use hub messaging for something a tool can answer (e.g., grepping codebase, running a build).
//
// # Processes
//
// Project-scoped long-running processes shared by every omp instance in the same directory. A long-running service, watcher, debugger, REPL, or process needing later input MUST use `op:"start"`, not `bash`.
//
// - **`start`** launches `application` + `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
//   - `ready.log` is a JavaScript `RegExp` compiled with the `u` flag; PCRE inline modifiers such as `(?i)` are REJECTED — use `[Rr]eady` instead. `ready.port` is a TCP port. Both supplied? BOTH MUST pass. `ready.timeout` is seconds. Readiness MUST be observed; process creation alone is not readiness.
//   - Names are unique per project directory. A completed name MAY be started again; a live name MUST be stopped or restarted.
//   - `restart` policy defaults `no`; `on-failure` and `always` use bounded backoff.
//   - `persist: true` opts out of last-omp teardown; `detached: true` survives broker shutdown and all omp exits (implies persist, disables PTY input). Omit both unless their survival guarantees are required.
// - **`ps`**, **`logs`**, **`wait`** (with `name`), **`send`** (with `name`), **`stop`**, **`restart`**, and **`describe`** address the stable `name`.
// - **`logs`** defaults to the last 100 lines. `head: true` reads the beginning. `grep` is a JavaScript `RegExp` compiled with the `u` flag (no inline modifiers such as `(?i)`). `follow: true` waits for output after `cursor`; reuse the returned cursor on the next call.
// - **`wait`** with `name` blocks until readiness/exit/`pattern` or `timeout` (seconds). `pattern` is a JavaScript `RegExp` compiled with the `u` flag (no inline modifiers such as `(?i)`).
// - **`send`** with `name`: `text` writes stdin (`enter` defaults true); `keys` supports ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT; `signal` supports SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGKILL. PTY input is serialized; writes share one input stream.
// - **`stop`** performs graceful process-tree termination before hard-kill; NEVER kill an unverified PID through bash. **`restart`** reuses the retained launch spec.
//
// @example "List peers"
// list
// @example "Inspect parked peer history"
// hub(op="list", status="parked")
// @example "Fire-and-forget DM — same send wakes idle/parked peers"
// hub(op="send", to="AuthLoader", message="Still touching src/server/auth.ts? I need to add a 401 path.")
// @example "Round-trip when you cannot proceed without the answer"
// hub(op="send", to="Main", message="JWT or session cookies for the auth flow?", await=True)
// @example "Completely blocked: wait for the first finished job or incoming message"
// wait
// @example "Block until a specific peer answers"
// hub(op="wait", from="AuthLoader", timeoutMs=60000)
// @example "Kill a hung background job"
// hub(op="cancel", ids=["bash_a1b2c3"])
// @example "Snapshot every background job without waiting"
// jobs
// @example "Start a dev server and wait for its log banner and port"
// hub(op="start", name="web", application="bun", args=["run", "dev"], ready={"log": "Local:.*http", "port": 5173, "timeout": 30})
// @example "Follow process output after a cursor"
// hub(op="logs", name="web", follow=True, cursor=1842, timeout=30)
// @example "Drive a REPL/debugger over stdin"
// hub(op="send", name="debugger", text="breakpoint set --name main")
// @example "Interrupt a process"
// hub(op="send", name="debugger", keys=["CTRL_C"])
// @example "Block until a process is ready"
// hub(op="wait", name="web", for="ready", timeout=30)
type hub = (_: {
// hub operation
op: "send" | "wait" | "inbox" | "list" | "jobs" | "cancel" | "start" | "ps" | "logs" | "stop" | "restart" | "describe",
// send: recipient agent id or "all"
to?: string,
// send: message body
message?: string,
// send: message id being answered
replyTo?: string,
// send: wait for the recipient's reply (invalid with to:"all")
await?: boolean,
// wait: only accept a message from this agent id
from?: string,
// wait: job ids to watch (omit = all running jobs); cancel: job ids to kill
ids?: string[],
// wait (messages/jobs): timeout in milliseconds (0 waits indefinitely)
timeoutMs?: number,
// inbox: list messages without consuming them
peek?: boolean,
// list: filter by status; omit for running+idle
status?: "running" | "idle" | "parked",
// list: max peer rows; default 32, max 100
limit?: number,
// process ops: stable project-scoped launch name
name?: string,
// start: executable or application path
application?: string,
// start: argv passed directly to the application
args?: string[],
// start: extra environment variables
env?: Record<string, string>,
// start: working directory; defaults to the session directory
cwd?: string,
// start: allocate an interactive PTY; default true
pty?: boolean,
// start: readiness conditions; all supplied conditions must pass
ready?: {
// regex matched against output
log?: string,
// TCP port that must accept connections
port?: number,
// TCP readiness host; default 127.0.0.1
host?: string,
// seconds to wait; default 30
timeout?: number,
},
// start: restart policy; default no
restart?: "no" | "on-failure" | "always",
// start: survive the last omp client exiting; default false
persist?: boolean,
// start: survive every omp and broker exit; implies persist and disables PTY input
detached?: boolean,
// logs: output lines; default 100, max 1000
lines?: number,
// logs: read from the beginning instead of the tail
head?: boolean,
// logs: regex filter
grep?: string,
// logs: wait for output newer than cursor
follow?: boolean,
// logs: output cursor returned by an earlier call
cursor?: number,
// wait with name: lifecycle condition; default exit
for?: "ready" | "exit",
// wait with name: output regex; takes precedence over for
pattern?: string,
// send with name: stdin text
text?: string,
// send with name: append Enter after text; default true
enter?: boolean,
// send with name: terminal keys after text
keys?: string[],
// send with name: process-tree signal
signal?: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL",
// logs/stop/wait with name: max seconds; default 30 (stop: 5)
timeout?: number,
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Coordinate peers, background jobs, and project-scoped processes. The user is not a peer; Main answers in normal text. list discovers exact peer IDs (running/idle by default; status:'parked' for history). send({to,message}) wakes known peers; await:true waits for one reply (not with to:'all'); replyTo answers a message. inbox drains queued messages. Use paths, not pasted blobs. Do not message peers for facts tools can obtain. Jobs auto-deliver on completion. jobs snapshots; cancel({ids}) stops jobs. wait only when blocked: returns on the first matching message, job settlement, timeout, or interrupt; ids/from narrow it. User steering needs a text answer before another wait. Long-running services/watchers/REPLs use start({name,application,args,ready}), not bash. Readiness requires the supplied log/port checks, not mere process creation. ps/logs/wait/send/stop/restart/describe with name operate on that process. logs follow uses cursor; patterns are JS RegExp with u, not PCRE inline modifiers. stop is graceful before hard kill. persist survives the last OMP client; detached survives broker exit and disables PTY input. Omit unless needed. A settled job or process exit is not proof its artifact is accepted.
//
// @example "List peers"
// list
// @example "Inspect parked peer history"
// hub(op="list", status="parked")
// @example "Fire-and-forget DM — same send wakes idle/parked peers"
// hub(op="send", to="AuthLoader", message="Still touching src/server/auth.ts? I need to add a 401 path.")
// @example "Round-trip when you cannot proceed without the answer"
// hub(op="send", to="Main", message="JWT or session cookies for the auth flow?", await=True)
// @example "Completely blocked: wait for the first finished job or incoming message"
// wait
// @example "Block until a specific peer answers"
// hub(op="wait", from="AuthLoader", timeoutMs=60000)
// @example "Kill a hung background job"
// hub(op="cancel", ids=["bash_a1b2c3"])
// @example "Snapshot every background job without waiting"
// jobs
// @example "Start a dev server and wait for its log banner and port"
// hub(op="start", name="web", application="bun", args=["run", "dev"], ready={"log": "Local:.*http", "port": 5173, "timeout": 30})
// @example "Follow process output after a cursor"
// hub(op="logs", name="web", follow=True, cursor=1842, timeout=30)
// @example "Drive a REPL/debugger over stdin"
// hub(op="send", name="debugger", text="breakpoint set --name main")
// @example "Interrupt a process"
// hub(op="send", name="debugger", keys=["CTRL_C"])
// @example "Block until a process is ready"
// hub(op="wait", name="web", for="ready", timeout=30)
type hub = (_: {
op: "send" | "wait" | "inbox" | "list" | "jobs" | "cancel" | "start" | "ps" | "logs" | "stop" | "restart" | "describe",
to?: string,
message?: string,
replyTo?: string,
await?: boolean,
from?: string,
ids?: string[],
timeoutMs?: number,
peek?: boolean,
status?: "running" | "idle" | "parked",
// Clamped to 100; defaults to 32
limit?: number,
name?: string,
application?: string,
args?: string[],
env?: Record<string, string>,
cwd?: string,
pty?: boolean,
ready?: {
log?: string,
port?: number,
host?: string,
timeout?: number,
},
restart?: "no" | "on-failure" | "always",
persist?: boolean,
detached?: boolean,
// Clamped to 1000
lines?: number,
head?: boolean,
grep?: string,
follow?: boolean,
cursor?: number,
for?: "ready" | "exit",
pattern?: string,
text?: string,
enter?: boolean,
keys?: string[],
signal?: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL",
timeout?: number,
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
