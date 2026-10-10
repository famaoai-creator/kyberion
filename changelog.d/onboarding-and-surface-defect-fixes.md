---
category: Fixed
---

- **scope.env no longer leaks into tests** — under vitest the persisted operator scope is ignored unless `KYBERION_SCOPE_ENV_PATH` points at a fixture.
- **Chronos no longer warns on non-pipeline JSON** — `_`-prefixed fixtures and data documents (design protocols) under `pipelines/` are skipped instead of warning every tick; `avatar-runtime-preflight` / `voice-profile-runtime-preflight` fragment include collisions fixed.
- **Surface status accuracy** — running-but-unprobeable surfaces (no port/healthPath) report healthy instead of degraded; `probe_active_profile`/`probe` report `kind: "denied"` for permission-denied files instead of conflating them with missing files.
- **`tenant create` atomicity** — a knowledge-root creation failure rolls back the just-written profile, and tenant lifecycle verbs self-bind to the target tenant instead of inheriting whatever scope.env happens to hold.
