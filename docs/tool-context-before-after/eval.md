# eval: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/tools/eval.ts). The old eval module hit a pre-existing import cycle in the isolated checkout. Its old ArkType schema was reconstructed from the old source; the description and examples were reused only after their runtime-source text was verified unchanged.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 1104 | 1104 | +0 |
| Provider tool definition (name + description + JSON Schema) | 1259 | 1223 | +36 |
| Full system-prompt inventory entry | 1343 | 1299 | +44 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

```text
Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
Eval `agent()` children use independent kernels.

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Two or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.

Top-level `await` works; `asyncio.run(…)` raises error.
JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.

On error, fix and re-run only the failing step.

<prelude>
Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
await tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object. Async: `await tool.read({...})`.
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → CompletionHandle
    Oneshot, stateless (no history/tools); returns immediately. `.wait()` → str (parsed object with `schema`). `model`: "smol" fast | "default" session | "slow" most capable.
agent(prompt, agent?="tiny-task", label?=None, schema?=None, schemaMode?="permissive", isolated?=None, apply?=None, merge?=None, tools?=None) → AgentHandle
    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `tiny-task`. Allowed agents: `tiny-task`, `atomic-task-reviewer`. Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes. `tools`: names of your @tool-defined tools the child may call.
    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools }).
wait(handles, timeout?=None, raise_errors?=True) → list
    Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot. JS: wait(handles, { timeout, raiseErrors }).
workpool(agent?=None, name?=None, context?=None, tools?=None) → WorkPool
    Default for 2+ independent items. `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item.
@tool / tool(fn, name=None, description=None)tool(fn, { name?, description?, parameters? })
    Define a tool that runs in this kernel (schema inferred from type hints); reference by name in `task` items' `tools`, `agent(tools=…)`, `workpool(tools=…)`. `tool.defined()`, `tool.undefine(name)`.
log(message) → None         phase(title) → None
budget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()``await budget.total()`, `await budget.spent()`, `await budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>
<dag>
Acyclic waves of handles:
- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
- **Acyclic only.** No node waits on its own descendant.
</dag>

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>
```

## After: description

```text
Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
Eval `agent()` children use independent kernels.

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Two or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.

Top-level `await` works; `asyncio.run(…)` raises error.
JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.

On error, fix and re-run only the failing step.

<prelude>
Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
await tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object. Async: `await tool.read({...})`.
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → CompletionHandle
    Oneshot, stateless (no history/tools); returns immediately. `.wait()` → str (parsed object with `schema`). `model`: "smol" fast | "default" session | "slow" most capable.
agent(prompt, agent?="tiny-task", label?=None, schema?=None, schemaMode?="permissive", isolated?=None, apply?=None, merge?=None, tools?=None) → AgentHandle
    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `tiny-task`. Allowed agents: `tiny-task`, `atomic-task-reviewer`. Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes. `tools`: names of your @tool-defined tools the child may call.
    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools }).
wait(handles, timeout?=None, raise_errors?=True) → list
    Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot. JS: wait(handles, { timeout, raiseErrors }).
workpool(agent?=None, name?=None, context?=None, tools?=None) → WorkPool
    Default for 2+ independent items. `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item.
@tool / tool(fn, name=None, description=None)tool(fn, { name?, description?, parameters? })
    Define a tool that runs in this kernel (schema inferred from type hints); reference by name in `task` items' `tools`, `agent(tools=…)`, `workpool(tools=…)`. `tool.defined()`, `tool.undefine(name)`.
log(message) → None         phase(title) → None
budget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()``await budget.total()`, `await budget.spent()`, `await budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>
<dag>
Acyclic waves of handles:
- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
- **Acyclic only.** No node waits on its own descendant.
</dag>

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>
```

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "language": {
      "enum": [
        "py",
        "js"
      ],
      "type": "string",
      "description": "runtime: \"py\" for the IPython kernel, \"js\" for the persistent JS VM"
    },
    "code": {
      "type": "string",
      "description": "code to run in this eval call, verbatim. Use top-level await freely."
    },
    "title": {
      "type": "string",
      "description": "short label shown in transcript (e.g. \"imports\", \"load config\")"
    },
    "timeout": {
      "type": "number",
      "description": "timeout for this eval call in seconds; 0 disables the cell timeout"
    },
    "reset": {
      "type": "boolean",
      "description": "wipe this language's kernel before running. Other languages are untouched."
    }
  },
  "required": [
    "language",
    "code"
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
    "language": {
      "description": "runtime: \"py\" for the IPython kernel, \"js\" for the persistent JS VM",
      "type": "string",
      "enum": [
        "py",
        "js"
      ]
    },
    "title": {
      "type": "string"
    },
    "timeout": {
      "type": "number"
    },
    "reset": {
      "type": "boolean"
    },
    "code": {
      "description": "code to run in this eval call, verbatim. Use top-level await freely.",
      "type": "string"
    }
  },
  "required": [
    "language",
    "code"
  ],
  "additionalProperties": false
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
// Eval `agent()` children use independent kernels.
//
// Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
// Two or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.
//
// Top-level `await` works; `asyncio.run(…)` raises error.
// JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.
//
// On error, fix and re-run only the failing step.
//
// <prelude>
// Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.
// ```
// display(value) → None        print(value, ...) → None
// read(path, offset?=1, limit?=None) → str
// write(path, content) → str
// env(key?=None, value?=None) → str | None | dict
// output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
// await tool.<name>(args) → unknown
//     Invoke any session tool; `args` = its parameter object. Async: `await tool.read({...})`.
// completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → CompletionHandle
//     Oneshot, stateless (no history/tools); returns immediately. `.wait()` → str (parsed object with `schema`). `model`: "smol" fast | "default" session | "slow" most capable.
// agent(prompt, agent?="tiny-task", label?=None, schema?=None, schemaMode?="permissive", isolated?=None, apply?=None, merge?=None, tools?=None) → AgentHandle
//     Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `tiny-task`. Allowed agents: `tiny-task`, `atomic-task-reviewer`. Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes. `tools`: names of your @tool-defined tools the child may call.
//     JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools }).
// wait(handles, timeout?=None, raise_errors?=True) → list
//     Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot. JS: wait(handles, { timeout, raiseErrors }).
// workpool(agent?=None, name?=None, context?=None, tools?=None) → WorkPool
//     Default for 2+ independent items. `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item.
// @tool / tool(fn, name=None, description=None)tool(fn, { name?, description?, parameters? })
//     Define a tool that runs in this kernel (schema inferred from type hints); reference by name in `task` items' `tools`, `agent(tools=…)`, `workpool(tools=…)`. `tool.defined()`, `tool.undefine(name)`.
// log(message) → None         phase(title) → None
// budget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()``await budget.total()`, `await budget.spent()`, `await budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.
// ```
// </prelude>
// <dag>
// Acyclic waves of handles:
// - **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
// - **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
// - **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
// - **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
// - **Acyclic only.** No node waits on its own descendant.
// </dag>
//
// <critical>
// Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
// </critical>
//
// @example "First call — set up once"
// eval(language="py", title="imports", code="""import json
// from pathlib import Path""")
// @example "Second call — reuse, do NOT re-import"
// eval(language="py", title="load config", code="""data = json.loads(read('package.json'))
// display(data)""")
// @example "Third call — reuse the loaded config"
// eval(language="py", title="scan deps", code="display(sorted(data['dependencies']))")
type eval = (_: {
// runtime: "py" for the IPython kernel, "js" for the persistent JS VM
language: "py" | "js",
// code to run in this eval call, verbatim. Use top-level await freely.
code: string,
// short label shown in transcript (e.g. "imports", "load config")
title?: string,
// timeout for this eval call in seconds; 0 disables the cell timeout
timeout?: number,
// wipe this language's kernel before running. Other languages are untouched.
reset?: boolean,
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
// Eval `agent()` children use independent kernels.
//
// Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
// Two or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.
//
// Top-level `await` works; `asyncio.run(…)` raises error.
// JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.
//
// On error, fix and re-run only the failing step.
//
// <prelude>
// Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.
// ```
// display(value) → None        print(value, ...) → None
// read(path, offset?=1, limit?=None) → str
// write(path, content) → str
// env(key?=None, value?=None) → str | None | dict
// output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
// await tool.<name>(args) → unknown
//     Invoke any session tool; `args` = its parameter object. Async: `await tool.read({...})`.
// completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → CompletionHandle
//     Oneshot, stateless (no history/tools); returns immediately. `.wait()` → str (parsed object with `schema`). `model`: "smol" fast | "default" session | "slow" most capable.
// agent(prompt, agent?="tiny-task", label?=None, schema?=None, schemaMode?="permissive", isolated?=None, apply?=None, merge?=None, tools?=None) → AgentHandle
//     Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `tiny-task`. Allowed agents: `tiny-task`, `atomic-task-reviewer`. Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes. `tools`: names of your @tool-defined tools the child may call.
//     JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools }).
// wait(handles, timeout?=None, raise_errors?=True) → list
//     Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot. JS: wait(handles, { timeout, raiseErrors }).
// workpool(agent?=None, name?=None, context?=None, tools?=None) → WorkPool
//     Default for 2+ independent items. `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item.
// @tool / tool(fn, name=None, description=None)tool(fn, { name?, description?, parameters? })
//     Define a tool that runs in this kernel (schema inferred from type hints); reference by name in `task` items' `tools`, `agent(tools=…)`, `workpool(tools=…)`. `tool.defined()`, `tool.undefine(name)`.
// log(message) → None         phase(title) → None
// budget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()``await budget.total()`, `await budget.spent()`, `await budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.
// ```
// </prelude>
// <dag>
// Acyclic waves of handles:
// - **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
// - **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
// - **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
// - **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
// - **Acyclic only.** No node waits on its own descendant.
// </dag>
//
// <critical>
// Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
// </critical>
//
// @example "First call — set up once"
// eval(language="py", title="imports", code="""import json
// from pathlib import Path""")
// @example "Second call — reuse, do NOT re-import"
// eval(language="py", title="load config", code="""data = json.loads(read('package.json'))
// display(data)""")
// @example "Third call — reuse the loaded config"
// eval(language="py", title="scan deps", code="display(sorted(data['dependencies']))")
type eval = (_: {
// runtime: "py" for the IPython kernel, "js" for the persistent JS VM
language: "py" | "js",
title?: string,
timeout?: number,
reset?: boolean,
// code to run in this eval call, verbatim. Use top-level await freely.
code: string,
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
