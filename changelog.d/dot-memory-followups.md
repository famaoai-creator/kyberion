---
category: Added
---

- **Resident dots remember and schedule follow-ups** — a dot keeps a bounded private working memory (notes, open items, hypotheses) it edits through `dot_update_memory` and sees in its next prompt, and can ask to be woken again later with `dot_schedule_followup` (5 minutes to 7 days, few pending). Cron runs missed during an outage are coalesced into one catch-up wake (`runtime.cron_catch_up_hours`, default 6). Resolved hypotheses are distilled weekly into reviewable execution-feedback candidates. No action needed.
