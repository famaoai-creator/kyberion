---
category: Fixed
---

- Added `pnpm kyberion pr body`, which renders `.github/PULL_REQUEST_TEMPLATE.md` into a compliant PR body scaffold — Mission ID auto-detected (or `--mission`), `## Knowledge` lines rendered from the mission's memory candidates — so the KL-02/KL-03 publication contract is generated rather than hand-authored; and made `pnpm generate:types` convergent (tier unions resolve to `StorageDataTier`, output is prettier-canonical) and enrolled it in the generated-artifact machinery with a `contract-types` `--check` gate, so contract drift can no longer accumulate silently.
