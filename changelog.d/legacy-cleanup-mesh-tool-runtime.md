---
category: Changed
---

- **Mesh hub inspection no longer shows topics** — the topic subscription view read a journal that nothing writes, so it is retired together with the documentation-only `mesh-hub-policy.json`. `pnpm kyberion mesh-hub inspect` keeps the peers and delivery views.
- **One place decides where tool runtimes live** — tool-runtime paths are defined once in `tool-runtime-policy.ts`. Installs (venvs, binaries, `state.json`, provider CLIs) live only under `active/shared/runtime/tool-runtimes`, and that is the only place searched for them. Voice setup takes its uv / pip / XDG / Hugging Face download caches from `active/shared/cache/system/tool-runtimes/<runtime>` and finds managed Python through the same registry lookup as meeting preflight. That download cache is no longer swept file by file after 30 days; clearing it is the operator's call.
- `pnpm kyberion mesh-hub inspect topics` (or any unknown section) now fails with a clear error instead of printing the full report.
- Removed the `scripts/refactor/` re-export shims left from the mission-module move; imports use `@agent/core/mission/*`.
