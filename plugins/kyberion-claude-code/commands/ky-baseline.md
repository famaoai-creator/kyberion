---
description: Run the Kyberion baseline-check pipeline and branch on its status.
---

Run the Kyberion baseline health check and act on the result:

1. Execute `pnpm pipeline --input pipelines/baseline-check.json`.
2. Read the report's `status` and follow CLAUDE.md §3:
   - `needs_recovery` → enter Recovery
   - `needs_onboarding` → enter Onboarding
   - `needs_attention` → surface the failed layer to me, then Alignment
   - `all_clear` → Alignment
   - `fatal_error` → report and halt
3. Tell me which phase you are entering and why.
