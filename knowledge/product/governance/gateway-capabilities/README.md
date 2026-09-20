# Gateway Capability Registry Canonical Directory

Canonical source for assimilated gateway capabilities (RSP-14).

- One capability per file: `{capability_id}.json` (file name must match `capability_id`).
- Each file carries the shared envelope (`version`) plus a single-element
  `capabilities` array, validating against
  `knowledge/product/schemas/gateway-capability-registry.schema.json` as-is.
- The directory starts empty: entries are created by
  `pipelines/assimilate-gateway-capability.json` via
  `scripts/registry_manager.ts` (`--type gateway`). Adapter profile artifacts
  live in the sibling `adapters/` directory.

- `index.json` is omitted while the ledger is empty; entries are created by the assimilate pipeline.
