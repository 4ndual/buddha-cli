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
| Buddha router, Siddhi-only root, clean five-line prompt | `buddha-v1` mode extension | Pending extraction from fork core |
| `complete` and `parent` tools | `buddha-v1` extension tools | Pending extraction from dirty fork state |
| Delegated-task lifecycle supervision and telemetry | Profile extension plus any minimal lifecycle event seam | Pending extraction |
| Prompt Analyzer application | Buddha sidecar launched/configured by profile extension | Pending extraction |
| Modified cross-root session discovery in CLI | Bridge/profile index; generic discovery seam only if required | Pending extraction |

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

The installer refuses an existing destination and writes through a temporary
directory followed by one rename. It never changes `~/.buddha`, the default
`~/.omp/agent`, the global `omp` link, or a running CodeNomad/OMP process.

The bridge may run with `OMP_PROFILE=buddha-v1` as its default. Its profile-aware
backend also exposes `GET /profile` and accepts `profile` on `POST /session`, so a
client can select `stock`, `buddha-v1`, or future workflow profiles per new
terminal without mutating the bridge process or global OMP state. Historical
scanning includes the active profile and retains the legacy `.omp` and `.buddha`
roots during migration.
