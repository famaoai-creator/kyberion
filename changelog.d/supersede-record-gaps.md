---
category: Fixed
---

- **supersede-task closes its last record gaps.**
  - **Abandoned receipts:** an abandoned run can leave a receipt under another approval. A run under a new approval now writes its own receipt and audit entry, and keeps the old receipt beside it (`<task>.abandoned-<approval>.json`).
  - **Dependencies rewritten again:** a WorkItem dependency can come back after it was rewritten. When it is rewritten again, the rewrite gets its own marker time and its own ledger, audit and receipt record (`late_rewrites`), safe across crashes and recorded once.
  - **Resumed runs:** the result of a resumed run now lists every dependent the supersede rewired.
