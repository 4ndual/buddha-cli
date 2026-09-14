# OMP profile templates

These directories are source-controlled templates for OMP's native named-profile
layout. They are not loaded from the repository and do not affect the default
profile until explicitly installed under `~/.omp/profiles/<name>/agent`.

- `stock` is intentionally empty and exercises the upstream OMP defaults.
- `buddha-v1` owns Buddha-specific extensions, agents, skills, prompts, hooks,
  and settings. Runtime behavior must enter through a profile-loaded extension.

Use `omp --profile stock` or `omp --profile buddha-v1` after installing the
corresponding template. Never point either profile at `~/.buddha`: that directory
remains migration input and rollback state for the existing Buddha runtime.
