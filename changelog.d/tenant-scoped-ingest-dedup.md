---
category: Fixed
---

- **Document imports use the selected destination** — identical files can now be filed independently into different authorized tenants. Duplicate checks use each tenant’s committed asset ledger; same-tenant duplicates and version/reparse behavior are preserved, and an obsolete global hash registry can no longer block a valid import or fail after the ledger commit.
