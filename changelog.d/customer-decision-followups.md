---
category: Fixed
---

- Customer decision facade: every verb refuses a `--tenant` that differs from the process's bound tenant (or a malformed bound tenant). Before, a process bound to one tenant could confirm another tenant's customer decision and release its held task.
- Customer decision `confirm` and `submit` record the approver from the human approval decision, and keep `--by` as `requested_by` / `submitted_by`. Their approval requests carry ids only, are scoped to the confidential tenant, and include the tenant in the correlation id. Requests still pending from before the upgrade are not matched: the next run opens a fresh request, and the old one can be cancelled.
- Customer decision reminders: a pending reminder approval left on a previous surface or channel is cancelled with a recorded reason; a `before_due` reminder approved after the day's sweep goes out on the next sweep (one day at most, bound to the agenda content), and only one reminder per decider goes out on the due day. Reminders held at upgrade time are asked once more.
- Customer room: rate limits key on the client address from `X-Forwarded-For` only when the direct peer is listed in `KYBERION_CUSTOMER_ROOM_TRUSTED_PROXIES` (default: trust nobody; `Forwarded` is never read).
