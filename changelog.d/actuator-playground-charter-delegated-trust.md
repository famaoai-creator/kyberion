---
category: Added
---

- **The project-trust step for scratch ADFs is charter-delegable** — `pipeline_trust_grant` is now a delegable decision type in the charter vocabulary. `pnpm pipeline --input <adf> --delegated-trust [person|tenant:<slug>]` asks the accountability charter for that scope to decide instead of waiting on a human project-trust approval; the delegated decision is bound to the exact file content (content-hash correlation id), audited and charged to the charter ledger, and a deny/stop falls back to the normal approval path. `pnpm playground -- --emit-adf` probes active charters and prints the delegated run form when one already covers the draft.
