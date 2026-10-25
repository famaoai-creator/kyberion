---
title: Governed evidence tools for delegated workers
tags: [mission, evidence, governance, requirements, design-spec, worker-tools]
last_updated: 2026-10-25
role_affinity: [implementer]
phase_affinity: [alignment, contract_authoring]
---

# Governed evidence tools for delegated workers

Workers must NOT write governed mission evidence directly — schema validation
and versioning live behind facades. Stage a JSON payload under
`active/shared/tmp/` and call the matching tool; the tool validates against the
canonical schema and saves via the governed facade.

## Requirements draft (alignment tasks)

```bash
node --import ./scripts/ts-loader.mjs scripts/requirements_draft.ts save \
  --mission <MISSION_ID> --project-name <name> \
  --file active/shared/tmp/req-draft-<task>.json --by <your-work-item-id>
```

Payload shape (`knowledge/product/schemas/requirements-draft.schema.json`):
`functional_requirements[].id` = `FR-<n>`, `description`, `priority` ∈
`must|should|could|wont` (every `must` needs non-empty `acceptance_criteria`).
`open_questions` entries block unless `"blocking": false` or status ≠ `open`.
Extra properties are rejected. Saves versioned `v1`, `v2`, … and clears stale
signoff on re-extraction. Verify with `requirements_draft.ts show --mission <ID>`.

## Design spec (contract_authoring tasks)

```bash
node --import ./scripts/ts-loader.mjs scripts/design_spec.ts save \
  --mission <MISSION_ID> --project-name <name> \
  --file active/shared/tmp/design-spec-<work-item-id>.json --by <work-item-id>
```

Payload shape (`knowledge/product/schemas/design-spec.schema.json`): top level
needs `version`, `project_name`, `generated_at`, nonempty `components[]` where
each component has `id` = `COMP-[0-9A-Z]+`, `name`, `responsibility`.
ARCHITECTURE_READY requires ≥1 component carrying `requirements_refs` and no
blocking open decisions. Verify with `design_spec.ts gate --mission <ID>`.

Never write `evidence/requirements-draft.json` or `evidence/design-spec.json`
by hand — persona-gated writes will be refused and unaudited.
