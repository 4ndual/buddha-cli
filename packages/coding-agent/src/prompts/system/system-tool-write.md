# write

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 1
- Description: 187
- JSON schema: 43
- Total: 231

## Description

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

## JSON schema

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
