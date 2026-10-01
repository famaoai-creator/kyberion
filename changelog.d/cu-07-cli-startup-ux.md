---
category: Changed
---

- CU-07: unknown `KYBERION_*` variables now warn once (with did-you-mean) outside CI instead of blocking every `kyberion` command; CI or `KYBERION_ENV_REGISTRY_STRICT=1` stays strict and invalid values of known variables still fail.
- pads: the missing-tenant error now names `--tier public` and `pnpm tenant list` (en + ja).
- `pnpm mission status` and other read-only verbs skip the reasoning-backend bootstrap; `run_with_env` notes injected variable names at debug level.
