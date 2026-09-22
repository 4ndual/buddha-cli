# edit: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/edit/index.ts). Both captures use the same available native addon for replace-mode description. The TypeScript schema changed; the description source did not.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 255 | 255 | +0 |
| Provider tool definition (name + description + JSON Schema) | 310 | 327 | -17 |
| Full system-prompt inventory entry | 299 | 299 | +0 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

```text
Single file string replacement; fuzzy whitespace matching.

<instruction>
- MUST use smallest `old_string` uniquely identifying change.
- Nonunique `old_string` → MUST add context or use `replace_all: true` for all occurrences.
- Rename a string across file → use `replace_all: true`.
- SHOULD edit existing files, not create new.
</instruction>

<output>
Success/failure status.
Success: file modified in place; replacement applied.
Failure — e.g., `old_string` absent or multiple matches without `replace_all: true`: error describes issue.
</output>

<critical>
- MUST read file at least once in conversation before editing. Tool errors on edit before read.
</critical>

<bash-alternatives>
Replace content-addressed — identify change by text.

Pattern-addressed bulk changes: bash more efficient:

|Operation|Command|
|---|---|
|Regex replace|`sd 'pattern' 'replacement' file`|
|Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|

Use Replace when content identifies location; `ast_edit` for structure-aware codemods.
For in-place edits prefer Replace or `write` — diff preview and fuzzy matching.
</bash-alternatives>
```

## After: description

```text
Single file string replacement; fuzzy whitespace matching.

<instruction>
- MUST use smallest `old_string` uniquely identifying change.
- Nonunique `old_string` → MUST add context or use `replace_all: true` for all occurrences.
- Rename a string across file → use `replace_all: true`.
- SHOULD edit existing files, not create new.
</instruction>

<output>
Success/failure status.
Success: file modified in place; replacement applied.
Failure — e.g., `old_string` absent or multiple matches without `replace_all: true`: error describes issue.
</output>

<critical>
- MUST read file at least once in conversation before editing. Tool errors on edit before read.
</critical>

<bash-alternatives>
Replace content-addressed — identify change by text.

Pattern-addressed bulk changes: bash more efficient:

|Operation|Command|
|---|---|
|Regex replace|`sd 'pattern' 'replacement' file`|
|Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|

Use Replace when content identifies location; `ast_edit` for structure-aware codemods.
For in-place edits prefer Replace or `write` — diff preview and fuzzy matching.
</bash-alternatives>
```

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string"
    },
    "old_string": {
      "type": "string"
    },
    "new_string": {
      "type": "string"
    },
    "replace_all": {
      "type": "boolean"
    }
  },
  "required": [
    "path",
    "old_string",
    "new_string"
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
      "type": "string"
    },
    "old_string": {
      "type": "string"
    },
    "new_string": {
      "type": "string"
    },
    "replace_all": {
      "type": "boolean"
    }
  },
  "required": [
    "path",
    "old_string",
    "new_string"
  ],
  "additionalProperties": false
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Single file string replacement; fuzzy whitespace matching.
//
// <instruction>
// - MUST use smallest `old_string` uniquely identifying change.
// - Nonunique `old_string` → MUST add context or use `replace_all: true` for all occurrences.
// - Rename a string across file → use `replace_all: true`.
// - SHOULD edit existing files, not create new.
// </instruction>
//
// <output>
// Success/failure status.
// Success: file modified in place; replacement applied.
// Failure — e.g., `old_string` absent or multiple matches without `replace_all: true`: error describes issue.
// </output>
//
// <critical>
// - MUST read file at least once in conversation before editing. Tool errors on edit before read.
// </critical>
//
// <bash-alternatives>
// Replace content-addressed — identify change by text.
//
// Pattern-addressed bulk changes: bash more efficient:
//
// |Operation|Command|
// |---|---|
// |Regex replace|`sd 'pattern' 'replacement' file`|
// |Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|
//
// Use Replace when content identifies location; `ast_edit` for structure-aware codemods.
// For in-place edits prefer Replace or `write` — diff preview and fuzzy matching.
// </bash-alternatives>
type edit = (_: {
path: string,
old_string: string,
new_string: string,
replace_all?: boolean,
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Single file string replacement; fuzzy whitespace matching.
//
// <instruction>
// - MUST use smallest `old_string` uniquely identifying change.
// - Nonunique `old_string` → MUST add context or use `replace_all: true` for all occurrences.
// - Rename a string across file → use `replace_all: true`.
// - SHOULD edit existing files, not create new.
// </instruction>
//
// <output>
// Success/failure status.
// Success: file modified in place; replacement applied.
// Failure — e.g., `old_string` absent or multiple matches without `replace_all: true`: error describes issue.
// </output>
//
// <critical>
// - MUST read file at least once in conversation before editing. Tool errors on edit before read.
// </critical>
//
// <bash-alternatives>
// Replace content-addressed — identify change by text.
//
// Pattern-addressed bulk changes: bash more efficient:
//
// |Operation|Command|
// |---|---|
// |Regex replace|`sd 'pattern' 'replacement' file`|
// |Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|
//
// Use Replace when content identifies location; `ast_edit` for structure-aware codemods.
// For in-place edits prefer Replace or `write` — diff preview and fuzzy matching.
// </bash-alternatives>
type edit = (_: {
path: string,
old_string: string,
new_string: string,
replace_all?: boolean,
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
