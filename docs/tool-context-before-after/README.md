# OMP tool-context before/after audit

[Capture script](../../scripts/capture-tool-context.ts) and [Markdown generator](../../scripts/generate-tool-context-audit.ts). Old checkout: `89c4b8dff5`; current capture: working tree after the tool rewrite. The baseline is one explicit configuration: read limit 3000, memory off, async off, both eval backends on, edit replace/full, task flat/no isolation, and the five core tools available. Other profiles and settings produce different context.

| Tool | Description tokens | Provider definition tokens | System-inventory tokens |
| --- | ---: | ---: | ---: |
| [read](./read.md) | 913 → 56 (+857) | 961 → 115 (+846) | 967 → 92 (+875) |
| [write](./write.md) | 187 → 75 (+112) | 231 → 145 (+86) | 225 → 117 (+108) |
| [bash](./bash.md) | 395 → 102 (+293) | 511 → 213 (+298) | 485 → 167 (+318) |
| [task](./task.md) | 459 → 459 (+0) | 544 → 595 (-51) | 520 → 550 (-30) |
| [ask](./ask.md) | 208 → 70 (+138) | 411 → 233 (+178) | 502 → 309 (+193) |
| [eval](./eval.md) | 1104 → 1104 (+0) | 1259 → 1223 (+36) | 1241 → 1299 (-58) |
| [hub](./hub.md) | 1237 → 266 (+971) | 2150 → 734 (+1416) | 2265 → 917 (+1348) |
| [edit](./edit.md) | 255 → 255 (+0) | 310 → 327 (-17) | 299 → 299 (+0) |
| **All eight if exposed** | **+2371 saved** | **+2792 saved** | **+2754 saved** |

The provider definition count includes the tool name, actual runtime description, and generated JSON Schema; the system inventory is OMP's rendered descriptor with examples. These are **alternative** presentation modes. Neither count includes provider framing, hidden overhead, repeated-turn caching, or billable-token behavior. The model does not receive the self-explanatory TypeScript source. Read each tool's caveat before attributing its delta to this migration—especially task (concurrent uncommitted runtime-tier edits) and eval (old module import cycle). Legacy Markdown files remain as source/history and are not live descriptions for the five shortened tools.
