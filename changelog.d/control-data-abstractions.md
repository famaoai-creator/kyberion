---
category: Changed
---

- Centralize provider/runtime/artifact diagnostics, service lifecycle intents, retry profiles, bridge polling, service/media catalogs, and schema-backed work/outcome types. PR lifecycle procedures retain governed execution gates and fail closed on readiness or check failures.
- Mission membership and dispatch require canonical WorkItem context. Preview legacy migration with `pnpm work migrate-context` and apply it explicitly with `pnpm work migrate-context --apply`; existing typed scope and role metadata are preserved.
