# bash

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 1
- Description: 352
- JSON schema: 102
- Total: 455

## Description

Runs commands in a persistent shell.

Use ONLY for one binary or a short pipeline that computes a fact (`wc -l`, `sort | uniq -c`, `diff`).
Inline scripts, heredocs, `$(…)`, complex control flow/quoting, and non-trivial pipelines → `eval`.

<instruction>
- Set `cwd` instead of `cd`; use `env: { NAME: "…" }` for multiline/quote-heavy values.
- `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands use `&&` in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
- aux utils available: mkdir, wc, sort, comm, diff, uniq, base64, cmp, md5sum, sha{1,224,256,384,512}sum, b2sum, basename, dirname, readlink, realpath, touch, stat, date, mktemp, seq, yes, printenv, truncate, tac, nproc, uname, whoami, hostname, which, ps, pgrep, pkill, pidwait, top, cut, tee, tr, paste, sed, xargs, jq, rm, mv, ln, ts, sponge, ifne, isutf8, combine, errno
- `async: true` defers a finite command's result; it does not extend `timeout`.
</instruction>

<critical>
- Avoid `head`, `tail`, and redirection: output is captured, truncated, and linked as `artifact://<id>`.
</critical>
No truncation footer means the displayed output is complete.

## JSON schema

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string"
    },
    "env": {
      "type": "object",
      "properties": {},
      "additionalProperties": {
        "type": "string"
      }
    },
    "timeout": {
      "type": "number",
      "description": "timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600"
    },
    "cwd": {
      "type": "string"
    },
    "pty": {
      "type": "boolean"
    },
    "async": {
      "type": "boolean",
      "description": "run in background"
    }
  },
  "required": [
    "command"
  ],
  "additionalProperties": false
}
```
