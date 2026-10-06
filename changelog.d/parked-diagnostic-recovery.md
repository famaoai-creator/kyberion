---
category: Added
---

- **Safe parked diagnostic recovery**: explicitly end a held first-job request only when strict retained evidence proves it never dispatched. Preserve the original approval and immutable recovery receipt, fail closed on missing or uncertain evidence, and offer a separately approved new request only after terminal readback. Recovery never retries execution.
