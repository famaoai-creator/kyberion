# Governance Body Registry Canonical Directory

Canonical source for governance body definitions (RSP-16).

- One body per file: `{id}.json` (file name must match `id`).
- Each file carries the shared envelope (`version`, `description`,
  `decision_outcomes`) plus a single-element `bodies` array, validating
  against `knowledge/product/schemas/governance-body-registry.schema.json` as-is.
- The legacy single file `governance-body-registry.json` has been removed
  (snapshot abolished). Writes via `scripts/register_workflow.ts`.

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.
