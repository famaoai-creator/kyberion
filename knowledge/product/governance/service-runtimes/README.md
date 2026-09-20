# Service Runtime Registry Canonical Directory

Canonical source for service runtime records (RSP-18).

- One service per file: `{service_id}.json` (file name must match `service_id`).
- Each file carries the shared envelope (`version`, `default_service_id`)
  plus a single-element `services` array, validating against
  `knowledge/product/schemas/service-runtime-registry.schema.json` as-is.
- The legacy single file `service-runtime-registry.json` has been removed
  (snapshot abolished). Loader: `libs/core/service-runtime-registry.ts`
  (`KYBERION_SERVICE_RUNTIME_REGISTRY_DIR` / `KYBERION_SERVICE_RUNTIME_REGISTRY_PATH`).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
