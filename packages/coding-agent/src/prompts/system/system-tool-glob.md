# glob

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 1
- Description: 171
- JSON schema: 102
- Total: 274

## Description

Globs files, directories, and path-backed internal URLs with fast pattern matching.

<instruction>
- `path`: glob, file, directory, or path-backed internal URL; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).
- `memory://` glob patterns are supported. `ssh://` has no local path; use `read`. Other internal URLs accept exact paths only.
- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.
- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.
</instruction>

<output>
Matches are newest-first and grouped by directory; directories end in `/`.
</output>

<avoid>
Open-ended multi-round discovery → Task + scout.
</avoid>

## JSON schema

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "glob, file, or directory to search — a single path or a semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted -> searches the workspace root (\".\")"
    },
    "hidden": {
      "type": "boolean",
      "description": "include hidden files"
    },
    "gitignore": {
      "type": "boolean",
      "description": "respect gitignore"
    },
    "limit": {
      "type": "number",
      "description": "max results"
    }
  },
  "additionalProperties": false
}
```
