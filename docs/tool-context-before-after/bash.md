# bash: before and after model-facing description

Baseline: source checkout at HEAD for the previous template, current working tree for the new tool. Conditional settings are fixed by [the generator](../../scripts/generate-tool-context-audit.ts); other profiles can differ. OMP may send this descriptor in the provider tool schema or move it into the system prompt. Neither the TypeScript source nor this audit file is itself sent to the model.

Previous description: **395** tokens. Current description: **102** tokens. Description-only saving: **293** tokens per exposed tool definition. Counted with OMP's Tokenizer strict mode (o200k fallback); provider framing, examples, schema JSON, caching, and billing are excluded.

## Before — rendered from packages/coding-agent/src/prompts/tools/bash.md

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

## After — current runtime description

```text
Run one command or short fact-producing pipeline in a persistent shell. Use cwd instead of cd; env for quoted/multiline values; pty only for terminal interaction. Order-dependent commands use &&. Prefer read for file contents/directories, glob for paths, grep for search, eval for scripts/complex control flow, hub start for long-running processes. Common shell utilities are available. Output is captured; truncated output links to artifact://. Internal URIs resolve to paths. timeout:0 disables the deadline.
```

## Code contract

The live input contract is `bashSchemaBase` in [packages/coding-agent/src/tools/bash.ts](../../packages/coding-agent/src/tools/bash.ts); Zod is the runtime parser and JSON Schema source. The schema is separately sent as a tool definition when this tool is active. The result contract is parsed at the tool boundary. This document is a measurement snapshot, not a replacement for executable code.
