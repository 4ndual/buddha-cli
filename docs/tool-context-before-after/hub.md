# hub: before and after model-facing description

Baseline: source checkout at HEAD for the previous template, current working tree for the new tool. Conditional settings are fixed by [the generator](../../scripts/generate-tool-context-audit.ts); other profiles can differ. OMP may send this descriptor in the provider tool schema or move it into the system prompt. Neither the TypeScript source nor this audit file is itself sent to the model.

Previous description: **1237** tokens. Current description: **266** tokens. Description-only saving: **971** tokens per exposed tool definition. Counted with OMP's Tokenizer strict mode (o200k fallback); provider framing, examples, schema JSON, caching, and billing are excluded.

## Before — rendered from packages/coding-agent/src/prompts/tools/hub.md

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

## After — current runtime description

```text
Coordinate peers, background jobs, and project-scoped processes. The user is not a peer; Main answers in normal text. list discovers exact peer IDs (running/idle by default; status:'parked' for history). send({to,message}) wakes known peers; await:true waits for one reply (not with to:'all'); replyTo answers a message. inbox drains queued messages. Use paths, not pasted blobs. Do not message peers for facts tools can obtain. Jobs auto-deliver on completion. jobs snapshots; cancel({ids}) stops jobs. wait only when blocked: returns on the first matching message, job settlement, timeout, or interrupt; ids/from narrow it. User steering needs a text answer before another wait. Long-running services/watchers/REPLs use start({name,application,args,ready}), not bash. Readiness requires the supplied log/port checks, not mere process creation. ps/logs/wait/send/stop/restart/describe with name operate on that process. logs follow uses cursor; patterns are JS RegExp with u, not PCRE inline modifiers. stop is graceful before hard kill. persist survives the last OMP client; detached survives broker exit and disables PTY input. Omit unless needed. A settled job or process exit is not proof its artifact is accepted.
```

## Code contract

The live input contract is `hubSchema` in [packages/coding-agent/src/tools/hub/index.ts](../../packages/coding-agent/src/tools/hub/index.ts); Zod is the runtime parser and JSON Schema source. The schema is separately sent as a tool definition when this tool is active. The result contract is parsed at the tool boundary. This document is a measurement snapshot, not a replacement for executable code.
