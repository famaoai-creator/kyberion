# Capability Bundle Registry Canonical Directory

This directory is the canonical source for capability bundle entries (RSP-11).

- One bundle per file: `{bundle_id}.json` (file name must match `bundle_id`).
- Each file carries the shared envelope (`$schema`, `version`) plus a
  single-element `bundles` array, so every file validates against
  `knowledge/product/schemas/capability-bundle-registry.schema.json` as-is.
- The legacy single file `capability-bundle-registry.json` has been removed
  (snapshot abolished). Runtime loaders read this directory first; the
  `KYBERION_CAPABILITY_BUNDLE_REGISTRY_PATH` env seam still allows hermetic
  tests to point at a single file.
- Loader: `libs/core/capability-bundle-registry.ts` via
  `libs/core/registry-directory.ts` (filename==id, duplicate detection,
  shared-header consistency, id-sorted merge).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
