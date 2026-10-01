---
category: Changed
---

- **Orphaned libs/core features wired or retired (OW-01/OW-02)** — the MO-07 best-of-N judge now fans out across provider CLIs when `KYBERION_BEST_OF_PROVIDERS_LIVE=1` (XP-07, default off); work-item dispatch registers judgment providers via `ensureJudgmentBackendsRegistered()` (built-in floor always, `laya-mlx` / `typesafe-jev` opt-in through the new `KYBERION_JUDGMENT_PROVIDERS`), so task-routing judgment can actually go live. 32 caller-less modules and `generateExcelWithDesign` moved to `retired/libs-core/` / `retired/libs-shared-media/` with their tests, barrel exports and package subpaths removed; `KYBERION_TELEMETRY`, `KYBERION_SOVEREIGN_SECRET` and the three operator-learning registry path variables are no longer read. Decision table: `docs/developer/improvement-plans-2026-10/ORPHAN_DECISIONS_2026-10-01.md`.
