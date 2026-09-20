# External Service Registry Seed Canonical Directory

Canonical source for the org-wide external-service seed (RSP-15).

- One service per file: `{service_id}.json` (file name must match `service_id`).
- Each file carries the shared envelope (`version`, `notes`) plus a
  single-element `services` array, validating against
  `knowledge/product/schemas/external-service-registry.schema.json` as-is.
- The legacy seed file `external-service-registry.json` has been removed
  (snapshot abolished). Personal (`knowledge/personal/orchestration/`) and
  runtime (`active/shared/runtime/`) layers remain single files and override
  the seed. Loader: `libs/core/external-service-registry.ts`.

- `index.json` is omitted while the seed is empty.
