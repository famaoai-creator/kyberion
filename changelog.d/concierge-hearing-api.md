---
category: Added
---

- **Concierge serves the hearing and conversation APIs** — `/api/hearing/*`, `/api/conversation` and `/api/ask-vocabulary` now also answer on Concierge, with the same bodies, statuses and error codes as Presence Studio, ahead of moving the `/ask` page. On Concierge the installation owner (signed in, on this machine or with a passkey step-up) answers, decides and hands off; other members may read a company's hearing but not change it, and `tenant=personal` opens the owner's own hearing store. Decision-ledger hearings are not available on Concierge yet. Studio keeps serving everything unchanged.
