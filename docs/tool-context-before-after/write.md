# write: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/tools/write.ts). The descriptors and schemas were read from instantiated tools in isolated source checkouts.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 187 | 75 | +112 |
| Provider tool definition (name + description + JSON Schema) | 231 | 145 | +86 |
| Full system-prompt inventory entry | 225 | 117 | +108 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

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

## After: description

```text
Create or replace a file; use edit for small existing-file changes. Archive entries use archive.ext:path/inside (zip-family, tar-family, asar). SQLite rows use db.sqlite:table[:key], with JSON content for update and empty content for delete. xd://<tool> dispatches mounted devices with JSON content. Do not create documentation or emoji unless requested.
```

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "file path"
    },
    "content": {
      "type": "string",
      "description": "file content"
    }
  },
  "required": [
    "path",
    "content"
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
    "path": {
      "description": "File path or writable internal URI; xd://<tool> dispatches a device.",
      "type": "string"
    },
    "content": {
      "type": "string"
    }
  },
  "required": [
    "path",
    "content"
  ],
  "additionalProperties": false
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Creates or overwrites file at specified path.
//
// <conditions>
// - Creating new files explicitly required by task
// - Replacing entire file contents when editing would be more complex
// - Supports `.zip` (and ZIP-based `.jar`/`.war`/`.ear`/`.apk`), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`, and `.asar` archive entries via `archive.ext:path/inside/archive`; other archive formats (`.rar`, `.7z`, `.iso`, …) are read-only
// - Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
// </conditions>
//
// <critical>
// - You SHOULD use Edit tool for modifying existing files
// - You NEVER create documentation files (*.md, README) unless explicitly requested
// - You NEVER use emojis unless requested
// </critical>
type write = (_: {
// file path
path: string,
// file content
content: string,
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Create or replace a file; use edit for small existing-file changes. Archive entries use archive.ext:path/inside (zip-family, tar-family, asar). SQLite rows use db.sqlite:table[:key], with JSON content for update and empty content for delete. xd://<tool> dispatches mounted devices with JSON content. Do not create documentation or emoji unless requested.
type write = (_: {
// File path or writable internal URI; xd://<tool> dispatches a device.
path: string,
content: string,
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
