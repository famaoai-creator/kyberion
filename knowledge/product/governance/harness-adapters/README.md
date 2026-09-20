# Harness Adapter Registry Canonical Directory

Canonical source for harness adapter profiles (RSP-13).

- One adapter per file: `{adapter_id}.json` (file name must match `adapter_id`).
- Each file carries the shared envelope (`version`) plus a single-element
  `profiles` array, validating against
  `knowledge/product/schemas/harness-adapter-registry.schema.json` as-is.
- The legacy single file `harness-adapter-registry.json` has been removed
  (snapshot abolished). Read via `loadAdapterRegistry()` in
  `scripts/generate_provider_cli_capability_report.ts`.

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
