---
category: Fixed
---

- **Unanswered dot decisions no longer stall a dot.** A proposal that waits on the operator past the charter's `decisions.decision_expiry_minutes` (default 24 hours), or past its own request expiry, now expires. The approval request is marked `expired`, the action is declined, and its delegation slot is freed. The charter expiry never pre-empts a live veto window. It applies only once the card has no window or has fallen back to a human decision. Expiry is not a rejection, so it does not raise the dot's learned floor. Previously, a veto card that reached only the local inbox waited forever and permanently held the slot.
- **`dot status` shows what the dot last said.** The wake ledger keeps a short summary of the dot's reply, without the proposal block. A wake that proposed nothing still explains itself. Tenant-scoped dots never write this summary, because the wake ledger is a shared system file.
