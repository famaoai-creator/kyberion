---
category: Fixed
---

- **Event intake finds introduced secrets** — the intake surface resolved its HMAC secret from the process environment only, so a secret stored with `pnpm kyberion secret introduce` (keychain) was never found and every delivery failed verification. It now resolves through the `event-intake` service identity (`secret introduce event-intake GITHUB_SECRET` → `EVENT_INTAKE_GITHUB_SECRET`), keychain included.
