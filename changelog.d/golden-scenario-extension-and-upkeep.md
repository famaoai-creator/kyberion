---
category: Added
---

- **Golden-scenario verdicts for extension runs, backfill and status** — Chrome-extension (`extension_session`) runs are now judged by the host after completion: the extension sends only the page elements matching the procedure's success conditions (`submit_golden_evidence`), and `libs/core/browser/browser-golden-evidence.ts` evaluates them with the shared golden-scenario evaluator, bound to the run's persisted `completed` receipt and judged once per receipt. The extension's own in-page pass/fail (which counted unsupported conditions as passed) is removed; the side panel shows the host's pass / fail / inconclusive. `pnpm kyberion procedure golden backfill [--dry-run]` creates golden scenarios for procedures promoted before they were stored, and `pnpm kyberion procedure golden status` lists each procedure's check state and what it needs, failures first.
