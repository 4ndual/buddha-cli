# ask

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 1
- Description: 208
- JSON schema: 202
- Total: 411

## Description

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

## JSON schema

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
