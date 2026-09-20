# Registry Split Plan

This plan tracks catalog/index splits that should move from centralized JSON blobs to per-item canonical files plus a compatibility snapshot.

## Bottom line

- Canonical source should be the per-item directory.
- The global index stays as a generated compatibility snapshot until all consumers migrate.
- Validation must check both directory completeness and snapshot sync.

## Tasks

| ID     | Registry                    | Status      | Scope                                                                                                                                                                                                                                 |
| ------ | --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RSP-1  | Agent profile index         | completed   | Split `knowledge/product/orchestration/agent-profile-index.json` into `knowledge/product/orchestration/agent-profiles/*.json`.                                                                                                        |
| RSP-2  | Voice profile registry      | completed   | Split `knowledge/product/governance/voice-profile-registry.json` into `knowledge/product/governance/voice-profiles/*.json`.                                                                                                           |
| RSP-3  | Global actuator index       | completed   | Split `knowledge/product/orchestration/global_actuator_index.json` into the per-actuator package manifests under `libs/actuators/*/manifest.json`.                                                                                    |
| RSP-4  | Surface provider catalog    | completed   | Split `knowledge/product/governance/surface-provider-manifest-catalog.json` into `knowledge/product/governance/surface-provider-manifest-catalogs/*.json`.                                                                            |
| RSP-5  | Voice engine registry       | completed   | Split `knowledge/product/governance/voice-engine-registry.json` into `knowledge/product/governance/voice-engines/*.json`.                                                                                                             |
| RSP-6  | Service endpoints catalog   | completed   | Split `knowledge/product/orchestration/service-endpoints.json` into `knowledge/product/orchestration/service-endpoints/*.json`.                                                                                                       |
| RSP-7  | Specialist catalog          | completed   | Split `knowledge/product/orchestration/specialist-catalog.json` into `knowledge/product/orchestration/specialists/*.json`.                                                                                                            |
| RSP-8  | Authority role index        | completed   | Split `knowledge/product/governance/authority-role-index.json` into `knowledge/product/governance/authority-roles/*.json`.                                                                                                            |
| RSP-9  | Team role index             | in_progress | Split `knowledge/product/orchestration/team-role-index.json` into `knowledge/product/orchestration/team-roles/*.json`.                                                                                                                |
| RSP-10 | Model registry              | completed   | Split `knowledge/product/governance/model-registry.json` into `knowledge/product/governance/model-registry/*.json` with `index.json` metadata.                                                                                        |
| RSP-11 | Capability bundle registry  | completed   | Split `knowledge/product/governance/capability-bundle-registry.json` into `knowledge/product/governance/capability-bundles/*.json` (snapshot abolished).                                                                              |
| RSP-12 | Harness capability registry | completed   | Split `knowledge/product/governance/harness-capability-registry.json` into `knowledge/product/governance/harness-capabilities/*.json` (snapshot abolished; writes via `scripts/registry_manager.ts --type harness`).                  |
| RSP-13 | Harness adapter registry    | completed   | Split `knowledge/product/governance/harness-adapter-registry.json` into `knowledge/product/governance/harness-adapters/*.json` (snapshot abolished).                                                                                  |
| RSP-14 | Gateway capability registry | completed   | Split `knowledge/product/governance/gateway-capability-registry.json` into `knowledge/product/governance/gateway-capabilities/*.json` (snapshot abolished; empty ledger, entries via `pipelines/assimilate-gateway-capability.json`). |
| RSP-15 | External service seed       | completed   | Split `knowledge/product/orchestration/external-service-registry.json` into `knowledge/product/orchestration/external-services/*.json` (snapshot abolished; personal + runtime layers stay single files).                             |
| RSP-16 | Governance body registry    | completed   | Split `knowledge/product/governance/governance-body-registry.json` into `knowledge/product/governance/governance-bodies/*.json` (snapshot abolished; writes via `scripts/register_workflow.ts`).                                      |
| RSP-17 | Tool runtime registry       | completed   | Split `knowledge/product/governance/tool-runtime-registry.json` into `knowledge/product/governance/tool-runtimes/*.json` (snapshot abolished).                                                                                        |
| RSP-18 | Service runtime registry    | completed   | Split `knowledge/product/governance/service-runtime-registry.json` into `knowledge/product/governance/service-runtimes/*.json` (snapshot abolished).                                                                                  |
| RSP-19 | Media backend registry      | completed   | Split `knowledge/product/governance/media-backend-registry.json` into `knowledge/product/governance/media-backends/*.json` (snapshot abolished; voice backends still merged at runtime from voice-engine-registry).                   |
| RSP-20 | Reasoning provider registry | completed   | Split `knowledge/product/governance/reasoning-provider-registry.json` into `knowledge/product/governance/reasoning-providers/*.json` (snapshot abolished).                                                                            |

## Current migration rules

- File name must match the canonical item id.
- Snapshot files remain readable for compatibility (RSP-1–RSP-10).
- RSP-11+ abolishes the snapshot: the single-file JSON is deleted and loaders
  read the canonical directory only. Each per-item file carries the shared
  envelope (`version`, defaults) plus a single-element item array so it
  validates against the existing registry schema as-is (voice-profiles precedent).
  Shared-header consistency, duplicate detection, and id-sorted merge live in
  `libs/core/registry-directory.ts`.
- New runtime loaders must read the canonical directory first.
- Schema and governance checks must fail if directory and snapshot diverge.
- Empty ledgers (gateway capabilities, external-service seed) use
  `allowEmpty` directory loads instead of throwing.

## Non-targets

- `service-harness-registry.json` is a **generated artifact** (built by
  `scripts/generate_service_harness_registry.ts` from the already-split
  `service-presets/*.json` source directory) — splitting the generated file
  would be wrong; the source is already per-item.
- Policy-like single files (`env-registry.json`, `approval-policy.json`,
  `mission-process-registry.json`, …) stay single-file: they are updated
  atomically and rarely extended with independent items.

## Migration notes

- `RSP-1` is the pilot for this pattern.
- After `RSP-1`, the next split should target the registry with the highest merge-conflict cost and the lowest consumer surface.
