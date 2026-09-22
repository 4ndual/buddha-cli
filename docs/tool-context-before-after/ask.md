# ask: before and after model-facing description

Baseline: source checkout at HEAD for the previous template, current working tree for the new tool. Conditional settings are fixed by [the generator](../../scripts/generate-tool-context-audit.ts); other profiles can differ. OMP may send this descriptor in the provider tool schema or move it into the system prompt. Neither the TypeScript source nor this audit file is itself sent to the model.

Previous description: **208** tokens. Current description: **70** tokens. Description-only saving: **138** tokens per exposed tool definition. Counted with OMP's Tokenizer strict mode (o200k fallback); provider framing, examples, schema JSON, caching, and billing are excluded.

## Before — rendered from packages/coding-agent/src/prompts/tools/ask.md

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

## After — current runtime description

```text
Ask only when existing sources cannot resolve a choice with materially different user tradeoffs. Send related questions together; 2–5 concise options each, with tradeoffs in description. recommended is a zero-based default; multi allows multiple selections. Do not include Other: the UI adds it. Prefer action and state reasonable defaults when the choice is not material.
```

## Code contract

The live input contract is `askSchema` in [packages/coding-agent/src/tools/ask.ts](../../packages/coding-agent/src/tools/ask.ts); Zod is the runtime parser and JSON Schema source. The schema is separately sent as a tool definition when this tool is active. The result contract is parsed at the tool boundary. This document is a measurement snapshot, not a replacement for executable code.
