# ask: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/tools/ask.ts). The descriptors and schemas were read from instantiated tools in isolated source checkouts.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 208 | 70 | +138 |
| Provider tool definition (name + description + JSON Schema) | 411 | 233 | +178 |
| Full system-prompt inventory entry | 502 | 309 | +193 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

```text
Ask user for clarification/input during task execution.

<conditions>
- Multiple approaches with significantly different tradeoffs user should weigh.
</conditions>

<instruction>
- `recommended: <index>` marks default (0-indexed); " (Recommended)" added automatically.
- Use `questions` for related questions, not one at a time.
- Set `multi: true` on a question to allow multiple selections.
- Short option labels; explanatory tradeoffs in `description`, not labels.
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Default to action. Resolve ambiguity via repo conventions, existing patterns, reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Ask only when options have materially different tradeoffs the user must decide.
- If multiple choices acceptable: pick most conservative/standard option; proceed; state choice.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>
```

## After: description

```text
Ask only when existing sources cannot resolve a choice with materially different user tradeoffs. Send related questions together; 2–5 concise options each, with tradeoffs in description. recommended is a zero-based default; multi allows multiple selections. Do not include Other: the UI adds it. Prefer action and state reasonable defaults when the choice is not material.
```

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "question id"
          },
          "question": {
            "type": "string",
            "description": "question text"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string",
                  "description": "display label"
                },
                "description": {
                  "type": "string",
                  "description": "optional explanatory text displayed below the label"
                },
                "preview": {
                  "type": "string",
                  "description": "optional rich preview content for interactive ask dialogs"
                }
              },
              "required": [
                "label"
              ],
              "additionalProperties": false
            },
            "description": "available options"
          },
          "header": {
            "type": "string",
            "description": "optional short display chip for rich ask dialogs"
          },
          "multi": {
            "type": "boolean",
            "description": "allow multiple selections"
          },
          "recommended": {
            "type": "number",
            "description": "recommended option index"
          }
        },
        "required": [
          "id",
          "question",
          "options"
        ],
        "additionalProperties": false
      },
      "minItems": 1,
      "description": "questions to ask"
    }
  },
  "required": [
    "questions"
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
    "questions": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "question": {
            "type": "string"
          },
          "header": {
            "type": "string"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string"
                },
                "description": {
                  "type": "string"
                },
                "preview": {
                  "type": "string"
                }
              },
              "required": [
                "label"
              ],
              "additionalProperties": false
            }
          },
          "multi": {
            "type": "boolean"
          },
          "recommended": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "id",
          "question",
          "options"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "questions"
  ],
  "additionalProperties": false
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Ask user for clarification/input during task execution.
//
// <conditions>
// - Multiple approaches with significantly different tradeoffs user should weigh.
// </conditions>
//
// <instruction>
// - `recommended: <index>` marks default (0-indexed); " (Recommended)" added automatically.
// - Use `questions` for related questions, not one at a time.
// - Set `multi: true` on a question to allow multiple selections.
// - Short option labels; explanatory tradeoffs in `description`, not labels.
// </instruction>
//
// <caution>
// - Provide 2-5 concise, distinct options.
// </caution>
//
// <critical>
// - Default to action. Resolve ambiguity via repo conventions, existing patterns, reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Ask only when options have materially different tradeoffs the user must decide.
// - If multiple choices acceptable: pick most conservative/standard option; proceed; state choice.
// - Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
// </critical>
//
// @example "Single question"
// ask(questions=[{"id": "auth_method", "question": "Which authentication method should this API use?", "options": [{"label": "JWT", "description": "Bearer tokens for stateless API clients."}, {"label": "OAuth2", "description": "Delegated authorization with external identity providers."}, {"label": "Session cookies", "description": "Browser-first authentication backed by server-side sessions."}], "recommended": 0}])
// @example "Multiple questions"
// ask(questions=[{"id": "storage_type", "question": "Which storage backend?", "options": [{"label": "SQLite"}, {"label": "PostgreSQL"}]}, {"id": "auth_method", "question": "Which auth method?", "options": [{"label": "JWT"}, {"label": "Session cookies"}]}])
type ask = (_: {
// questions to ask
questions: Array<{
// question id
id: string,
// question text
question: string,
// available options
options: Array<{
// display label
label: string,
// optional explanatory text displayed below the label
description?: string,
// optional rich preview content for interactive ask dialogs
preview?: string,
}>,
// optional short display chip for rich ask dialogs
header?: string,
// allow multiple selections
multi?: boolean,
// recommended option index
recommended?: number,
}>,
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Ask only when existing sources cannot resolve a choice with materially different user tradeoffs. Send related questions together; 2–5 concise options each, with tradeoffs in description. recommended is a zero-based default; multi allows multiple selections. Do not include Other: the UI adds it. Prefer action and state reasonable defaults when the choice is not material.
//
// @example "Single question"
// ask(questions=[{"id": "auth_method", "question": "Which authentication method should this API use?", "options": [{"label": "JWT", "description": "Bearer tokens for stateless API clients."}, {"label": "OAuth2", "description": "Delegated authorization with external identity providers."}, {"label": "Session cookies", "description": "Browser-first authentication backed by server-side sessions."}], "recommended": 0}])
// @example "Multiple questions"
// ask(questions=[{"id": "storage_type", "question": "Which storage backend?", "options": [{"label": "SQLite"}, {"label": "PostgreSQL"}]}, {"id": "auth_method", "question": "Which auth method?", "options": [{"label": "JWT"}, {"label": "Session cookies"}]}])
type ask = (_: {
questions: Array<{
id: string,
question: string,
header?: string,
options: Array<{
label: string,
description?: string,
preview?: string,
}>,
multi?: boolean,
recommended?: number,
}>,
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
