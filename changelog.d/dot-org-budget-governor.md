---
category: Added
---

- **Organization-wide budget governor (DL-07)** — `org-budget-governor` aggregates daily token/cost usage per tenant/organization across resident dots, missions and generation, and evaluates a `normal`/`soft`/`hard` throttle against the new `org_budget` section of `spend-policy.json` (default 3M tokens/day, soft 0.8, hard 1.0). Not yet wired into the dot runtime. No action needed.
