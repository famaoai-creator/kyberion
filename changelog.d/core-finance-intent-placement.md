---
category: Changed
---

- Grouped financial models and resource usage cost/budget policy in `core/finance`, keeping monetary costs distinct from generation quota units.
- Moved contextual, pending and unhandled intent helpers into `core/intent`. Existing public import keys, storage roots, tenant boundaries, TTLs and authorization budgets are unchanged.
