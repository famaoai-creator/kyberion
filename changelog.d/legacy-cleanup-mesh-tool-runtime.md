---
category: Changed
---

- **Mesh hub inspection no longer shows topics** — the topic subscription view read a journal that nothing writes, so it is retired together with the documentation-only `mesh-hub-policy.json`. `pnpm kyberion mesh-hub inspect` keeps the peers and delivery views.
- **One place decides where tool runtimes live** — voice setup, meeting preflight, provider CLIs and the runtime registry now resolve paths through `tool-runtime-policy.ts`. Installs stay under `active/shared/runtime/tool-runtimes`; runtimes found only in the older cache location are still used. The download cache under `active/shared/cache/system/tool-runtimes` is no longer swept file by file after 30 days.
- Removed the `scripts/refactor/` re-export shims left from the mission-module move; imports use `@agent/core/mission/*`.
