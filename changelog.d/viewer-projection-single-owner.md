---
category: Changed
---

- **One viewer projection in Concierge** — the operations console (`/api/ops/*`) now uses the same viewer rules as every other Concierge route. A signed-in viewer sees the same data as before. Nothing to do. What changed:
  - An authorization failure on a Concierge route now answers 401 or 403 instead of 500.
  - An operations request whose viewer scope error carries 401 now answers 401 (was 403).
  - The personal tier is masked on the operations projection too. No resolved viewer held it, so no viewer loses access.
  - A personal-tier memory candidate is not shown through the inbox visibility rule, not even to its owner or a listed audience. No resolved Concierge viewer holds the personal tier, so nothing that was visible disappears.
  - A viewer whose permission set lacks `surface.headless.read` sees no memory candidates.
  - The viewer of an operations request is resolved once, so one authentication audit record is written per operations request instead of two (three for a token-authenticated mutation).
