# Buddha profile migration

## Boundary

The branch starts from upstream OMP `v18.1.21`. OMP's native named profiles are
the isolation mechanism; this work does not add a second profile system.

`stock` has no user extension or Buddha configuration. `buddha-v1` is assembled
from its versioned template plus an allowlisted import from the legacy
`~/.buddha/agent` directory. Authentication databases, session history, blobs,
caches, terminal state, and other mutable runtime data are deliberately not
copied by the installer.

## Layer 2 inventory and destination

| Existing Buddha behavior | Destination | Status |
| --- | --- | --- |
| Agent roles and model-role configuration | `buddha-v1/agent/agents` and `config.yml` | Imported by installer |
| User rules and personality | `buddha-v1/agent/AGENTS.md`, `PERSONALITY.md` | Imported by installer |
| Existing user extensions (output policy, reviewer prompts, Herdr state, peek, random role, completion gate, timer) | `buddha-v1/agent/extensions` | Allowlisted import |
| OMP Live terminal synchronization | Separate `omp-live-bridge` extension copied into `buddha-v1` | Bridge worktree adapted |
| Durable Hub inbox/channels | `buddha-runtime` profile extension | Implemented |
| Hub delivery observation | Generic OMP IRC observer seam | Implemented; inert without extension |
| Cross-extension runtime API | Generic namespaced service registry | Implemented; duplicate ownership fails closed |
| Todo read/write, branch/tree navigation, persistent tool approval | Generic extension context actions | Implemented; used by OMP Live |
| `.buddha` and default-profile history discovery | OMP Live compatibility scanner | Preserved alongside active named profile |
| Buddha router, Siddhi-only root, clean five-line prompt | `buddha-v1` profile runtime | Implemented; provider request is fail-closed to one prompt and `siddhi` |
| `complete` and `parent` tools | `buddha-tools` profile extension | Implemented for delegated agents |
| Delegated-task lifecycle supervision | Generic timer/cancellation seam plus `omp.task-lifecycle` profile service | Implemented; stock registers no policy |
| Delegated-task telemetry | Generic bounded run snapshot plus profile formatter | Implemented; collected generically and rendered only by `buddha-v1` |
| Prompt Analyzer application | Existing `@oh-my-pi/prompt-analyzer` workspace package | Separate optional companion, as in the current installation; it is not coupled to CLI/profile startup |
| Modified cross-root session discovery in CLI | Bridge profile index and compatibility scanner | Implemented without changing stock CLI discovery |

## Installation contract

Build and verify the branch first. Then, from a quiescent migration window:

```bash
bun scripts/install-profile.ts \
  --profile stock

bun scripts/install-profile.ts \
  --profile buddha-v1 \
  --legacy-agent-dir ~/.buddha/agent \
  --bridge-dir ../omp-live-bridge-profile
```

A first install refuses an existing destination and writes through a temporary
directory followed by one rename. It never changes `~/.buddha`, the default
`~/.omp/agent`, the global `omp` link, or a running CodeNomad/OMP process.

## Update contract

`--update` ships a later revision of the same template into a profile that is
already installed. It is the only supported way to move a fix into a live
profile; hand-copying files into `~/.omp/profiles/<name>/agent` is not.

```bash
bun scripts/install-profile.ts \
  --profile buddha-v1 \
  --update
```

The update runs in this order, and stops at the first step that fails:

1. Stage the tree a fresh install of the same template would produce, in
   `profiles/<name>/.agent.update-<pid>`. A bad template or a bad
   `--legacy-agent-dir` fails here, with the live profile untouched.
2. Move the installed tree aside, whole, to
   `profile-backups/<name>/agent-<timestamp>`. Backups live outside `profiles/`
   so nothing scanning that directory mistakes one for an installed profile.
3. Carry forward from the backup every path the new tree does not provide:
   `agent.db`, `history.db`, `models.db`, `sessions`, `terminal-sessions`,
   `cache`, imported rules, and any hand-added file. The template owns its own
   paths and wins every collision, so an update converges on what a fresh
   install of that template would produce.
4. Swap the staged tree in with one rename.
5. Verify on disk: every file the template owns is present with the template's
   bytes, and every carried path is present. Success is declared from the tree
   on disk, never from the copy plan.

Any failure at step 3, 4 or 5 restores the backup before the command exits, so
the profile is either the new tree or the old one and never a half-update. The
update is idempotent: running it twice leaves a working profile both times, the
second run carrying the same state forward and writing its own backup.

`--rollback` restores the most recent `agent-<timestamp>` backup for the
profile, or the one named by `--backup <dir>`:

```bash
bun scripts/install-profile.ts \
  --profile buddha-v1 \
  --rollback
```

The tree rollback displaces is itself moved aside, to
`profile-backups/<name>/superseded-<timestamp>`. No path in the installer
deletes anything: every tree it stops using is moved aside under
`profile-backups/<name>/` as `agent-`, `superseded-`, `failed-` or
`discarded-`, and reclaiming that space is a deliberate, separate act.

`--update` on a profile that was never installed is refused rather than
silently installing it, and first install still refuses an existing
destination. Run either from a quiescent window: the installer does not stop a
running CLI, and a profile updated underneath a live process keeps the code it
already loaded until it restarts.

The bridge is the CodeNomad backend compatibility boundary. It may run with
`OMP_PROFILE=buddha-v1` as its default, exposes `GET /profile`, and accepts
`profile` on `POST /session`. CodeNomad can therefore select `stock`,
`buddha-v1`, or future workflow profiles per new terminal without mutating the
bridge process or global OMP state. The selected profile is returned in live
session metadata, passed to the spawned CLI, and used for service discovery.
History scanning includes the active profile and retains the legacy `.omp` and
`.buddha` roots during migration.

Prompt Analyzer stays deliberately independent: the current application is a
manually started two-window HTTP/WebSocket companion, not a hook in the Buddha
CLI launch path. A future profile-owned sidecar supervisor can be added without
changing this profile runtime contract, but auto-starting it now would alter
current behavior and introduce a shared port/process lifecycle into every
session.
