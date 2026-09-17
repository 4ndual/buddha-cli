# hub

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 1
- Description: 1237
- JSON schema: 912
- Total: 2150

## Description

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

## JSON schema

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
