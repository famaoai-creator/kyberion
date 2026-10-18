---
category: Fixed
---

- Mission completion now prepares scoped workflow reuse candidates with static validation and explicit review handoff. Candidates bind the validated pipeline snapshot and recover safely after interrupted writes.
- Provider hooks remain usable while build outputs are temporarily unavailable, with tool authorization kept fail-closed. Regenerate existing wiring with `pnpm generate:provider-hooks`.
- Mission ledger appends and task updates now refresh their hash receipts, and replay reads a consistent snapshot. Repair legacy empty-ledger receipts with `pnpm mission repair <ID>` before resuming; historical ledger bytes are retained.
- Reminder sweeps use the correct sink contract without declaring a result channel that the operation does not return.
