---
category: Changed
---

- **One Authority Role registry** (concept model v2 D6) — every Authority Role is a card in `knowledge/product/governance/authority-roles/`, holding its catalog profile and its path `permissions`. `authority-role-index.json` and `security-policy.json` `authority_role_permissions` are now generated from the cards by `pnpm kyberion sync authority-roles`; edit the card and regenerate instead of editing either file. The `governance-rules` gate fails when the policy and the cards disagree. Roles that only scripts or services assume are cards with `"assignable": false` and stay out of the role index. No permission changed: both generated files are identical to the previous ones.
