# Harness Capability Registry Canonical Directory

Canonical source for harness capability entries (RSP-12).

- One capability per file: `{capability_id}.json` (file name must match `capability_id`).
- Each file carries the shared envelope (`version`) plus a single-element
  `capabilities` array, validating against
  `knowledge/product/schemas/harness-capability-registry.schema.json` as-is.
- The legacy single file `harness-capability-registry.json` has been removed
  (snapshot abolished). Runtime reads via `loadCapabilityRegistry()` in
  `libs/core/provider-capability-scanner.ts`; writes via
  `scripts/registry_manager.ts` (`--type harness`).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
