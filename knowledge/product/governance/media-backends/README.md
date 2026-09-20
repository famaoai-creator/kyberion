# Media Backend Registry Canonical Directory

Canonical source for media backend records (RSP-19).

- One backend per file: `{backend_id}.json` (file name must match `backend_id`).
- Each file carries the shared envelope (`version`, `default_backend_ids`)
  plus a single-element `backends` array, validating against
  `knowledge/product/schemas/media-backend-registry.schema.json` as-is.
- The legacy single file `media-backend-registry.json` has been removed
  (snapshot abolished). Voice backends are still merged at runtime from
  `voice-engine-registry`. Loader: `libs/core/media-backend-registry.ts`
  (`KYBERION_MEDIA_BACKEND_REGISTRY_DIR` / `KYBERION_MEDIA_BACKEND_REGISTRY_PATH`).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
