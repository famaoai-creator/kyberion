# Registry Split Plan

This plan tracks catalog/index splits that should move from centralized JSON blobs to per-item canonical files plus a compatibility snapshot.

## Bottom line

- Canonical source should be the per-item directory.
- The global index stays as a generated compatibility snapshot until all consumers migrate.
- Validation must check both directory completeness and snapshot sync.

## Tasks

| ID | Registry | Status | Scope |
|---|---|---|---|
| RSP-1 | Agent profile index | completed | Split `knowledge/public/orchestration/agent-profile-index.json` into `knowledge/public/orchestration/agent-profiles/*.json`. |
| RSP-2 | Voice profile registry | completed | Split `knowledge/public/governance/voice-profile-registry.json` into `knowledge/public/governance/voice-profiles/*.json`. |
| RSP-3 | Global actuator index | completed | Split `knowledge/public/orchestration/global_actuator_index.json` into the per-actuator package manifests under `libs/actuators/*/manifest.json`. |
| RSP-4 | Surface provider catalog | completed | Split `knowledge/public/governance/surface-provider-manifest-catalog.json` into `knowledge/public/governance/surface-provider-manifest-catalogs/*.json`. |
| RSP-5 | Voice engine registry | completed | Split `knowledge/public/governance/voice-engine-registry.json` into `knowledge/public/governance/voice-engines/*.json`. |
| RSP-6 | Service endpoints catalog | completed | Split `knowledge/public/orchestration/service-endpoints.json` into `knowledge/public/orchestration/service-endpoints/*.json`. |
| RSP-7 | Specialist catalog | completed | Split `knowledge/public/orchestration/specialist-catalog.json` into `knowledge/public/orchestration/specialists/*.json`. |
| RSP-8 | Authority role index | completed | Split `knowledge/public/governance/authority-role-index.json` into `knowledge/public/governance/authority-roles/*.json`. |
| RSP-9 | Team role index | in_progress | Split `knowledge/public/orchestration/team-role-index.json` into `knowledge/public/orchestration/team-roles/*.json`. |

## Current migration rules

- File name must match the canonical item id.
- Snapshot files remain readable for compatibility.
- New runtime loaders must read the canonical directory first.
- Schema and governance checks must fail if directory and snapshot diverge.

## Migration notes

- `RSP-1` is the pilot for this pattern.
- After `RSP-1`, the next split should target the registry with the highest merge-conflict cost and the lowest consumer surface.
