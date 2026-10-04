---
category: Added
---

- `pnpm kyberion dot status` now renders every registered status section (budget, key results, outcomes, autonomy, executor) and includes them in `--json`; new read-only views `dot memory|followups|kr|autonomy|outcomes|work <id>` and `dot event ingest --source <s> --file <json>` for local event testing. Tenant charters now load and transition in their tenant context, and `event_intake_surface` has a least-privilege system role.
