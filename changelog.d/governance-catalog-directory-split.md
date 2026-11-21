---
category: Changed
---

- Split the two highest-churn governed catalogs into per-entry directory sources: `security-policy.json` `authority_role_permissions` now live in `security-policy/roles/<role>.json` (with `role_order` in `index.json`) and `storage-retention-catalog.json` entries live in `storage-retention-catalog/entries/<hex(path)>.json` (with `entry_order`). The committed single files are generated artifacts assembled by `pnpm generate:governance-catalogs`; the `governance-catalogs` pr gate keeps them byte-identical to the sources. Edit per-entry files, not the generated single files.
