# Tool Runtime Registry Canonical Directory

Canonical source for tool runtime records (RSP-17).

- One tool per file: `{tool_id}.json` (file name must match `tool_id`).
- Each file carries the shared envelope (`version`, `default_tool_id`) plus a
  single-element `tools` array, validating against
  `knowledge/product/schemas/tool-runtime-registry.schema.json` as-is.
- The legacy single file `tool-runtime-registry.json` has been removed
  (snapshot abolished). Loader: `libs/core/tool-runtime-registry.ts`
  (`KYBERION_TOOL_RUNTIME_REGISTRY_DIR` / `KYBERION_TOOL_RUNTIME_REGISTRY_PATH`).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
