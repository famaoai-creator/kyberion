---
category: Added
---

- **Customer decision hearing (stage 1)** — `pnpm kyberion customer-decision` prepares an AI-DLC Inception agenda, proposes our decision for each item, locks the approved agenda by hash and prints a one-time invite link. The customer answers on the new `customer-room` surface (port 3046, mobile first): choose an option, keep the current way, or comment. The customer's answer overrides ours; until then work proceeds on our approved decision, then the organization default. Answers on money, contract, release and change-request topics stay provisional until the operator runs `customer-decision confirm` (approval-gated). Identity is invite-link only for now.
