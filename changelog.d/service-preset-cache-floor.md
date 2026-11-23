---
category: Changed
---

- **The service-preset TTL cache moved from the flat data vault to the cache floor.** `executeServicePresetCached` now stores entries at `active/shared/cache/<tier>/<tenant|shared>/service-preset/{project/<id>|global}/`. The tenant is the tenant of the admitted binding; a call with no admission uses the tier's `shared` partition. tier-guard and tenant scope protect these partitions, and an entry copied into another partition is never served there.
  - The `@agent/core/data-vault` module and the `data-vault-entry` schema are removed. Use `@agent/core/service-preset-cache` (`fetchWithServicePresetCache` with an explicit `{ tier, tenant?, projectId? }` scope), validated by `service-preset-cache-entry.schema.json`.
  - Offboarding finds service-preset cache data by path. A tenant offboarding exports and soft-deletes `cache/<tier>/<tenant>/service-preset/` (target kind `service_preset_cache_tree`). A project offboarding removes the project's subtree from its filter tenant's partition only, or from the untenanted `shared` partition. Key-based vault attribution and `PROJECT_DATA_VAULT_AMBIGUOUS` are gone.
  - `active/shared/data-vault/` is now a legacy retention entry, and nothing writes there. The janitor (`scanLegacyDataVault`, which replaces `scanDataVault`) deletes leftover files 30 days after their last write and audits each deletion. The entry and the sweep will be removed once deployments no longer have the directory.
