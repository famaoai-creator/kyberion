---
category: Added
---

- Add a typed runtime settings facade at `@agent/core/foundation/config`, generated from `env-registry.json` alongside `env.example` and `CONFIGURATION.md`. Feature code can read registered `KYBERION_*` values through `config.get` / `config.text` / `config.bool` without a new config domain; durable catalogs and config-mission mutation stay on their existing paths.
- Adopt the facade in foundation scope/service helpers and spend-guard, and fail ESLint on new `process.env.KYBERION_*` reads (foundation-adoption ratchet already at 0).
