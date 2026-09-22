# bash: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/tools/bash.ts). The descriptors and schemas were read from instantiated tools in isolated source checkouts.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 395 | 102 | +293 |
| Provider tool definition (name + description + JSON Schema) | 511 | 213 | +298 |
| Full system-prompt inventory entry | 485 | 167 | +318 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

```text
Runs commands in a persistent shell.

Use ONLY for one binary or a short pipeline that computes a fact (`wc -l`, `sort | uniq -c`, `diff`).
Inline scripts, heredocs, `$(…)`, complex control flow/quoting, and non-trivial pipelines → `eval`.

<instruction>
- Set `cwd` instead of `cd`; use `env: { NAME: "…" }` for multiline/quote-heavy values.
- `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands use `&&` in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
- aux utils available: mkdir, wc, sort, comm, diff, uniq, base64, cmp, md5sum, sha{1,224,256,384,512}sum, b2sum, basename, dirname, readlink, realpath, touch, stat, date, mktemp, seq, yes, printenv, truncate, tac, nproc, uname, whoami, hostname, which, ps, pgrep, pkill, pidwait, top, cut, tee, tr, paste, sed, xargs, jq, rm, mv, ln, ts, sponge, ifne, isutf8, combine, errno
</instruction>

<critical>
- NEVER use shell `grep`/`rg`; use built-in `grep`.
- List directories with `read` and find paths with `glob`; NEVER use `ls`/`find`.
- Avoid `head`, `tail`, and redirection: output is captured, truncated, and linked as `artifact://<id>`.
- Services, watchers, debuggers, and REPLs MUST use `hub` (`op:"start"`).
</critical>
No truncation footer means the displayed output is complete.
```

## After: description

```text
Run one command or short fact-producing pipeline in a persistent shell. Use cwd instead of cd; env for quoted/multiline values; pty only for terminal interaction. Order-dependent commands use &&. Prefer read for file contents/directories, glob for paths, grep for search, eval for scripts/complex control flow, hub start for long-running processes. Common shell utilities are available. Output is captured; truncated output links to artifact://. Internal URIs resolve to paths. timeout:0 disables the deadline.
```

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "command to execute"
    },
    "env": {
      "type": "object",
      "properties": {},
      "additionalProperties": {
        "type": "string"
      },
      "description": "extra env vars"
    },
    "timeout": {
      "type": "number",
      "description": "timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600"
    },
    "cwd": {
      "type": "string",
      "description": "working directory"
    },
    "pty": {
      "type": "boolean",
      "description": "run in pty mode"
    }
  },
  "required": [
    "command"
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
    "command": {
      "type": "string"
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
    "timeout": {
      "description": "timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600",
      "type": "number"
    },
    "cwd": {
      "type": "string"
    },
    "pty": {
      "type": "boolean"
    }
  },
  "required": [
    "command"
  ],
  "additionalProperties": false
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Runs commands in a persistent shell.
//
// Use ONLY for one binary or a short pipeline that computes a fact (`wc -l`, `sort | uniq -c`, `diff`).
// Inline scripts, heredocs, `$(…)`, complex control flow/quoting, and non-trivial pipelines → `eval`.
//
// <instruction>
// - Set `cwd` instead of `cd`; use `env: { NAME: "…" }` for multiline/quote-heavy values.
// - `pty: true` only for terminal interaction (`sudo`, `ssh`).
// - Order-dependent commands use `&&` in one call; independent calls may run concurrently.
// - Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
// - aux utils available: mkdir, wc, sort, comm, diff, uniq, base64, cmp, md5sum, sha{1,224,256,384,512}sum, b2sum, basename, dirname, readlink, realpath, touch, stat, date, mktemp, seq, yes, printenv, truncate, tac, nproc, uname, whoami, hostname, which, ps, pgrep, pkill, pidwait, top, cut, tee, tr, paste, sed, xargs, jq, rm, mv, ln, ts, sponge, ifne, isutf8, combine, errno
// </instruction>
//
// <critical>
// - NEVER use shell `grep`/`rg`; use built-in `grep`.
// - List directories with `read` and find paths with `glob`; NEVER use `ls`/`find`.
// - Avoid `head`, `tail`, and redirection: output is captured, truncated, and linked as `artifact://<id>`.
// - Services, watchers, debuggers, and REPLs MUST use `hub` (`op:"start"`).
// </critical>
// No truncation footer means the displayed output is complete.
type bash = (_: {
// command to execute
command: string,
// extra env vars
env?: Record<string, string>,
// timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600
timeout?: number,
// working directory
cwd?: string,
// run in pty mode
pty?: boolean,
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Run one command or short fact-producing pipeline in a persistent shell. Use cwd instead of cd; env for quoted/multiline values; pty only for terminal interaction. Order-dependent commands use &&. Prefer read for file contents/directories, glob for paths, grep for search, eval for scripts/complex control flow, hub start for long-running processes. Common shell utilities are available. Output is captured; truncated output links to artifact://. Internal URIs resolve to paths. timeout:0 disables the deadline.
type bash = (_: {
command: string,
env?: Record<string, string>,
// timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600
timeout?: number,
cwd?: string,
pty?: boolean,
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
