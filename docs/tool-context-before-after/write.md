# write: before and after model-facing description

Baseline: source checkout at HEAD for the previous template, current working tree for the new tool. Conditional settings are fixed by [the generator](../../scripts/generate-tool-context-audit.ts); other profiles can differ. OMP may send this descriptor in the provider tool schema or move it into the system prompt. Neither the TypeScript source nor this audit file is itself sent to the model.

Previous description: **187** tokens. Current description: **75** tokens. Description-only saving: **112** tokens per exposed tool definition. Counted with OMP's Tokenizer strict mode (o200k fallback); provider framing, examples, schema JSON, caching, and billing are excluded.

## Before — rendered from packages/coding-agent/src/prompts/tools/write.md

```text
Creates or overwrites file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
- Supports `.zip` (and ZIP-based `.jar`/`.war`/`.ear`/`.apk`), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`, and `.asar` archive entries via `archive.ext:path/inside/archive`; other archive formats (`.rar`, `.7z`, `.iso`, …) are read-only
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
</conditions>

<critical>
- You SHOULD use Edit tool for modifying existing files
- You NEVER create documentation files (*.md, README) unless explicitly requested
- You NEVER use emojis unless requested
</critical>
```

## After — current runtime description

```text
Create or replace a file; use edit for small existing-file changes. Archive entries use archive.ext:path/inside (zip-family, tar-family, asar). SQLite rows use db.sqlite:table[:key], with JSON content for update and empty content for delete. xd://<tool> dispatches mounted devices with JSON content. Do not create documentation or emoji unless requested.
```

## Code contract

The live input contract is `writeSchema` in [packages/coding-agent/src/tools/write.ts](../../packages/coding-agent/src/tools/write.ts); Zod is the runtime parser and JSON Schema source. The schema is separately sent as a tool definition when this tool is active. The result contract is parsed at the tool boundary. This document is a measurement snapshot, not a replacement for executable code.
