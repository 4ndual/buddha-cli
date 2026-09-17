# grep

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 1
- Description: 130
- JSON schema: 146
- Total: 277

## Description

Searches files/internal URLs: Rust regex, PCRE2 fallback.

<instruction>
- `path`: known files, directories, globs, internal URLs; roots `;`-separated.
- Broad searches may time out → narrow scope or use `glob` first.
- One-file line selector: `src/foo.ts:50-100`; never selects search root.
- Literal `\n` or `\\n` enables cross-line patterns.
</instruction>

<critical>
- MUST use instead of shell `grep`/`rg`.
- Open-ended multi-round search MUST use Task + scout, not chained calls.
</critical>

## JSON schema

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "regex pattern"
    },
    "path": {
      "type": "string",
      "description": "file, directory, glob, internal URL, or \"<file>:<lines>\" selector to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
    },
    "case": {
      "type": "boolean",
      "description": "case-sensitive search"
    },
    "gitignore": {
      "type": "boolean",
      "description": "respect gitignore"
    },
    "skip": {
      "description": "files to skip before collecting results — use to paginate when the prior call hit the file limit",
      "type": [
        "number",
        "null"
      ]
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false
}
```
