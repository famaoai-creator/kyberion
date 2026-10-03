---
category: Added
---

- **New-site browser learning playbook** — `knowledge/product/orchestration/browser-site-learning-playbook.md` unifies the Inspect → Scratch → Record → Crystallize → Verify → Promote flow for turning a new site's usage into replayable ADF, including when to use hand-written ADF vs extension recording vs trail export.
- **Browser discovery playbook now uses canonical ops** — examples use `control:browser:open_tab` → `capture:browser:snapshot` → `apply:browser:click|fill` with `selector + role/name`, same-session binding, and `about:blank` checks.
- **Resilient `export_adf`** — invalid non-secret trail entries are skipped with a warning (secret fills still fail fast), `screenshot` steps are kept, and non-replayable `scroll` / `select_tab` steps are dropped with a hint instead of emitting false replay. Trail parsing/export moved to `libs/actuators/browser-actuator/src/browser-adf-export.ts` (no caller changes).
