---
category: Added
---

- **One ledger for how conversations go** — `libs/core/intent/conversation-signals.ts` records turn outcomes, route misses, clarification questions and answers, and operator feedback in a single typed ledger (metadata plus a 100-character excerpt, never a tenant or isolated turn). `pnpm kyberion conversation report` shows per-intent results, unanswered clarifications and the utterances that keep failing, as candidates for the eval corpus. Retention is 90 days.
