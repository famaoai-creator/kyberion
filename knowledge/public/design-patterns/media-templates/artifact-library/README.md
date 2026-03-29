# Artifact Library

Kyberion's high-fidelity document catalog is stored as directory-scanned packs under this folder.

## Current Size

- Packs: `27`
- Profiles: `100`
- Machine-readable index: [index.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/index.json)

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
  - [project-mgmt.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/project-mgmt.json)
  - [project-mgmt-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/project-mgmt-high-fidelity.json)
  - [project-controls-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/project-controls-high-fidelity.json)
- Requirements
  - [requirements.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/requirements.json)
  - [requirements-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/requirements-high-fidelity.json)
- Architecture and engineering
  - [architecture.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/architecture.json)
  - [architecture-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/architecture-high-fidelity.json)
  - [engineering-architecture-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/engineering-architecture-high-fidelity.json)
  - [engineering-practice-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/engineering-practice-high-fidelity.json)
- Quality, release, and operations
  - [quality.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/quality.json)
  - [quality-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/quality-high-fidelity.json)
  - [release-ops.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/release-ops.json)
  - [release-ops-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/release-ops-high-fidelity.json)
  - [execution.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/execution.json)
- Governance, AI, privacy, and legal
  - [governance.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/governance.json)
  - [ai-governance-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/ai-governance-high-fidelity.json)
  - [privacy-compliance-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/privacy-compliance-high-fidelity.json)
  - [legal-compliance-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/legal-compliance-high-fidelity.json)
- Business functions
  - [business-strategy.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/business-strategy.json)
  - [business-strategy-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/business-strategy-high-fidelity.json)
  - [sales-cs-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/sales-cs-high-fidelity.json)
  - [marketing-legal-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/marketing-legal-high-fidelity.json)
  - [hr-ops-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/hr-ops-high-fidelity.json)
  - [corporate-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/corporate-high-fidelity.json)
- Industry and expansion
  - [biz-ops-industry-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/biz-ops-industry-fidelity.json)
  - [industrial-general-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/industrial-general-high-fidelity.json)
  - [expansion-high-fidelity.json](/Users/famao/kyberion/knowledge/public/design-patterns/media-templates/artifact-library/expansion-high-fidelity.json)

## Extension Rule

To add a new profile pack:

1. Add a JSON file under this directory with a top-level `profiles` object.
2. Keep each profile keyed by stable `document_profile` id.
3. Use `artifact_family`, `document_type`, and `sections` compatible with media-actuator.
4. Prefer adding machine-readable metadata in the pack itself rather than hardcoding assumptions in code.
