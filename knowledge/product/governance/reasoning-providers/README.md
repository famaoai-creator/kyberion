# Reasoning Provider Registry Canonical Directory

Canonical source for reasoning provider descriptors (RSP-20).

- One provider per file: `{mode}.json` (file name must match `mode`).
- Each file carries the shared envelope (`version`) plus a single-element
  `providers` array, validating against
  `knowledge/product/schemas/reasoning-provider-registry.schema.json` as-is.
- The legacy single file `reasoning-provider-registry.json` has been removed
  (snapshot abolished). Loader: `libs/core/reasoning-provider-registry.ts`
  (`KYBERION_REASONING_PROVIDER_REGISTRY_DIR` / `KYBERION_REASONING_PROVIDER_REGISTRY_PATH`).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
