---
category: Added
---

- **`probe` triggers for resident dots** — dot charters can now declare `kind: "probe"` attention triggers that evaluate declarative `file` or `service_preset` state probes each supervisor sweep and wake the dot on change (e.g., a GitHub PR leaving `open`). Trigger keys are fingerprint-deduped; `changed` expectations fire at-least-once from the delivered-fingerprint baseline.
- **`core:await_state` pipeline op** — a pipeline step can suspend until an external condition is satisfied (`probe` + `timeout_ms` + `on_timeout: abort|deny`). The chronos tick scans suspended runs and resumes them automatically.
- **`pnpm kyberion dot inbox append`** — append a row to the resident-dot wake lane by hand; channel adapters now emit the same rows on inbound turns, so `wake` channel triggers are connected end-to-end.
