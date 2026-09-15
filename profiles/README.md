# OMP profile templates

These directories are source-controlled templates for OMP's native named-profile
layout. They are not loaded from the repository and do not affect the default
profile until explicitly installed under `~/.omp/profiles/<name>/agent`.

- `stock` is intentionally empty and exercises the upstream OMP defaults.
- `buddha-v1` owns Buddha-specific extensions, agents, skills, prompts, hooks,
  and settings. Runtime behavior must enter through a profile-loaded extension.
- `chat` replaces the engineering-oriented system prompt with a concise,
  conversational policy. It answers stable questions directly, verifies
  freshness-sensitive claims through `sota-search`, and delegates only rarely.

Use `omp --profile stock`, `omp --profile buddha-v1`, or `omp --profile chat`
after installing the corresponding template. Never point these profiles at
`~/.buddha`: that directory remains migration input and rollback state for the
existing Buddha runtime.
