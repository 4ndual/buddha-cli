# @oh-my-pi/prompt-analyzer

Live prompt analyzer for Buddha. It takes one raw prompt and streams a four-stage
analysis of it into a browser while the model is still generating.

Pipeline: **wave 1** `paraphrase` + `categorize` in parallel, **wave 2** `analyze`,
**wave 3** `verify`. At most 2 concurrent model calls (`MAX_CONCURRENT_CALLS` in
`src/contracts.ts`). No subagents.

## Run it (two windows)

**Left window — the app.** Concise stage logs, on stderr:

```bash
cd /home/andual/Projects/buddha-cli
bun run packages/prompt-analyzer/src/main.ts            # or: bun --cwd packages/prompt-analyzer run start
```

```
Buddha prompt analyzer started
  http://localhost:7717
Browser connected
Prompt accepted: 4f2a9c1b7e05
Paraphrase started
Categorization started
Categorization completed in 1.2s
Paraphrase completed in 1.4s
Selected analysis started
Selected analysis completed in 3.1s
Verification started
Analysis verified in 1.9s
```

**Right window — the analyzer UI.** Open <http://localhost:7717>, paste a prompt,
watch the cards fill in as the model generates. The assembled JSON lives only in
the collapsed `Raw JSON` tab; everything above it is rendered cards, badges and
tabs.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `7717` (env `ANALYZER_PORT`) | HTTP + WebSocket port |
| `--model <id>` | env `ANALYZER_MODEL`, else `anthropic/claude-sonnet-5:low` | Model for every stage |
| `--verbose` | off | Adds protocol/frame detail to the stderr log |
| `--open` | off | Opens the UI in the default browser |

## Model

Default `anthropic/claude-sonnet-5:low` — proven working on this box. Override
with `ANALYZER_MODEL` or `--model`:

```bash
ANALYZER_MODEL=google/gemini-2.5-flash bun run packages/prompt-analyzer/src/main.ts
```

Sonnet and Gemini Flash are both approved for this MVP (explicitly chosen over
Luna-low). The `:low` / `:medium` / `:high` effort suffix is parsed by the
existing resolver (`packages/coding-agent/src/config/model-resolver.ts:147`
`splitThinkingSuffix`, `:209` `parseModelString`).

Stage calls are tool-free and JSON-only (`toolNames: []`, `restrictToolNames: true`).
Browser code never talks to a model provider; every model call goes through the
OMP SDK in this process.

Each stage instruction is a *creation-time* SDK option, not a post-hoc
`setSystemPrompt`: `AgentSession` rebuilds and re-applies its own base prompt on
every turn (`packages/coding-agent/src/session/session-tools.ts:1476`), so a
swapped prompt would be discarded. That means one session per stage (four,
created once and reused across runs with the transcript cleared), with a
semaphore holding dispatch to `MAX_CONCURRENT_CALLS` = 2.

## Logging

All human output goes to **stderr**, never stdout — redirect stdout anywhere and
it stays clean. The log never prints credentials, whole prompts, whole model
responses, protocol frames or per-token deltas. `--verbose` adds protocol detail,
still on stderr. `@oh-my-pi/pi-utils`'s `logger` (rotating file, never console)
is unchanged and unaffected.

## Shutdown

`SIGINT`/`SIGTERM` close the server, dispose the SDK transport and exit **0** with
no orphaned processes. The teardown is registered with `postmortem.register` and
driven by `postmortem.quit(0)`, and this CLI removes postmortem's own signal
listeners first: they exit `128 + signo` (`packages/utils/src/postmortem.ts:436`,
`:534`), which would race the async teardown and report 130/143 for a clean stop.
A 5 s guard forces the exit if teardown ever wedges.

## Browser protocol

WebSocket at `/ws` on the same origin as the page.

- client -> server: `{"type":"analyze","rawPrompt":"..."}` and `{"type":"cancel","runId":"..."}`
- server -> client: one `AnalysisEvent` (`src/contracts.ts:16`) JSON per message

`promptHash` = `sha256(rawPrompt)` hex, first 12 chars, derived **server-side**
(`hashPrompt`, `src/server.ts:44`); the client sends only `rawPrompt` and reads the
hash back from `run_started`.

Three invariants the server enforces:

1. **Latest prompt hash wins.** An `analyze` with a hash differing from the
   in-flight run emits `run_stale` for the old runId, calls
   `transport.cancel(oldRunId)`, and drops that run's late frames server-side —
   they never reach the browser.
2. **Same hash is idempotent.** An `analyze` matching the in-flight run's hash
   attaches to that run (the socket receives its snapshot); no second run starts.
3. **Reconnect is server-pushed.** Every new socket immediately receives a
   bounded snapshot of the live run (`run_started`, then per stage
   `stage_started` -> capped delta tail -> `stage_completed`/`stage_failed`, then
   the terminal event) before any new live frame, so a reload mid-run never shows
   an empty page. The retained delta tail is capped at 4 KB per stage.

## Deviations

**The OMP SDK is used instead of RPC mode.** The spec allows this when materially
simpler, and here it is the difference between one process and four.

RPC mode is JSONL-over-stdio with a custom envelope whose command union
(`packages/coding-agent/src/modes/rpc/rpc-types.ts:29-101`) has **no per-request
system prompt, model, tool-restriction or `outputSchema` override** — those are
launch-time only (`packages/coding-agent/src/main.ts:1071`, `--system-prompt` ->
`options.customSystemPrompt`). This analyzer needs four *different* stage system
prompts (`src/stage-prompts.ts`), so RPC would require four separate RPC
processes and would still give no structured-output control.

The SDK (`packages/coding-agent/src/sdk.ts`, `createAgentSession`) exposes all of
it per session: `systemPrompt` (`:431`), `model` (`:400`), `thinkingLevel`
(`:417`), `toolNames` + `restrictToolNames` (`:558-560`), `outputSchema` +
`outputSchemaMode` (`:578-580`), plus `sessionManager` (`:617`) and event
subscription with an `AbortSignal`.

The `OmpTransport` seam (`src/contracts.ts:74`) keeps this reversible: an RPC
adapter can be dropped in later without touching the server or the UI.
