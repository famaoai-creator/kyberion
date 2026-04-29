# Artifact Library

Kyberion's high-fidelity document catalog is stored as directory-scanned packs under this folder.

## Current Size

- Packs: `27`
- Profiles: `100`
- Machine-readable index: [index.json](./index.json)

## How It Is Used

- `media-actuator` scans this directory and merges `profiles` into the same resolver used by `document-composition-presets`
- curated defaults still live under `document-composition-presets`
- high-fidelity expansion lives here and becomes executable without code edits

CLI lookup:

- `pnpm control catalog profiles`
- `pnpm control catalog profiles risk`
- `pnpm control catalog profile vendor-risk-assessment-v2`

## Domain Packs

- Project management
  - [project-mgmt.json](./project-mgmt.json)
  - [project-mgmt-high-fidelity.json](./project-mgmt-high-fidelity.json)
  - [project-controls-high-fidelity.json](./project-controls-high-fidelity.json)
- Requirements
  - [requirements.json](./requirements.json)
  - [requirements-high-fidelity.json](./requirements-high-fidelity.json)
- Architecture and engineering
  - [architecture.json](./architecture.json)
  - [architecture-high-fidelity.json](./architecture-high-fidelity.json)
  - [engineering-architecture-high-fidelity.json](./engineering-architecture-high-fidelity.json)
  - [engineering-practice-high-fidelity.json](./engineering-practice-high-fidelity.json)
- Quality, release, and operations
  - [quality.json](./quality.json)
  - [quality-high-fidelity.json](./quality-high-fidelity.json)
  - [release-ops.json](./release-ops.json)
  - [release-ops-high-fidelity.json](./release-ops-high-fidelity.json)
  - [execution.json](./execution.json)
- Governance, AI, privacy, and legal
  - [governance.json](./governance.json)
  - [ai-governance-high-fidelity.json](./ai-governance-high-fidelity.json)
  - [privacy-compliance-high-fidelity.json](./privacy-compliance-high-fidelity.json)
  - [legal-compliance-high-fidelity.json](./legal-compliance-high-fidelity.json)
- Business functions
  - [business-strategy.json](./business-strategy.json)
  - [business-strategy-high-fidelity.json](./business-strategy-high-fidelity.json)
  - [sales-cs-high-fidelity.json](./sales-cs-high-fidelity.json)
  - [marketing-legal-high-fidelity.json](./marketing-legal-high-fidelity.json)
  - [hr-ops-high-fidelity.json](./hr-ops-high-fidelity.json)
  - [corporate-high-fidelity.json](./corporate-high-fidelity.json)
- Industry and expansion
  - [biz-ops-industry-fidelity.json](./biz-ops-industry-fidelity.json)
  - [industrial-general-high-fidelity.json](./industrial-general-high-fidelity.json)
  - [expansion-high-fidelity.json](./expansion-high-fidelity.json)

## Extension Rule

To add a new profile pack:

1. Add a JSON file under this directory with a top-level `profiles` object.
2. Keep each profile keyed by stable `document_profile` id.
3. Use `artifact_family`, `document_type`, and `sections` compatible with media-actuator.
4. Prefer adding machine-readable metadata in the pack itself rather than hardcoding assumptions in code.
