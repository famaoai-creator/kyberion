---
category: Added
---

- **Customer messages under a charter** — an owner can tick "let messages to customers go out without asking" on the charter pane. The signed statement then names `customer_outbound` (irreversible, one recipient, reputational class B) and allows `send_message_external`; `sendToCustomer` hands the gate the tenant charter. A message that breaches the audience egress floor, and every tenant without that explicit delegation, still goes to a human exactly as before.
- **Scheduled accountability report** — new `core:accountability_report` op and `pipelines/accountability-report-daily.json` (08:00 Asia/Tokyo, a no-op while no charter is in force). `approval_inbox charter` now shares the same builder (`runAccountabilityDigest`).
