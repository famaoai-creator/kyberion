---
category: Added
---

- Added the `union-literal-branches` PR gate: discriminant comparisons (`kind`/`provider`/`source === '<literal>'`) against registry-backed union members now fail outside the declaring module, so decisions route through the canonical guard/projection. Existing violations live in a shrink-only baseline.
