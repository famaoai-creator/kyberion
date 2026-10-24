---
category: Added
---

- **Bolt reviews for customers (CD-10, wave 1)** — `pnpm kyberion customer-decision bolt-review --mission <MSN> --summary-file <path> [--attach <png|jpeg|webp>]... [--preview-url <https URL>]` drafts one approval item ("do you accept the results of this bolt?") with the operator's summary, screenshots and a public preview link; submit and send it as any agenda. Images are checked (type from the bytes, 512 KB, 6 per item) and served to the customer room only through the new `attachment` verb for the sent agenda; links must be public https (no localhost, private addresses or internal host names). The next mission of the case closes the review's override window when it starts, without waiting for the customer. Customers may now also reject (comment required): a change request files one backlog WorkItem, a rejection notifies the operator, both with ids only. `finish` shows the bolt-review command for missions with a decision case.
