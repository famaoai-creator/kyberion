---
category: Changed
---

- **`org-operations` ships as a tenant-free template**: the resident organization-operations charter is no longer a live charter in `dots/` bound to one development tenant (machines without that tenant failed on every wake). It is now the draft template `knowledge/product/orchestration/dot-team-templates/org-operations.json` with `<tenant-slug>` / `<organization-id>` placeholders, keeping the cadence, `organization_operator` authority and `reasoning_training_use: no_training`, with local inbox delivery by default. Instantiate it per tenant organization with `pnpm kyberion dot create --file <draft.json> --apply` (written to `knowledge/confidential/<tenant>/dots/`), then `pnpm kyberion dot activate org-operations`.
