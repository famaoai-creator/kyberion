---
record_id: mem-MSN-FOUNDATION-CONFIG-20261108-2026_11_07
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FOUNDATION-CONFIG-20261108-2026_11_07
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-07T20:11:59.144Z
source_branch: feat/foundation-config-facade-20261108
source_commit: d626cad2407adde046bebd3851381c3b54a51847
---

# Typed configuration facade from env-registry

Generate a foundation/config facade from env-registry and keep durable catalogs and storage-backend off the settings path.

## Hint Scope

mission

## Trigger Phrases

- On post-#1441 placement, runtime KYBERION_* settings resolve through foundation/config → foundation/env ← secure-io registry reader. generate:env-registry emits types-only config.generated.ts. Do not invent a config domain or route settings through storage-backend. Prefer config.get/text/bool for registered names; keep MISSION_ID/SYSTEM_ROLE/HOME and dynamic keys on getRegisteredEnvText. ESLint forbids new process.env.KYBERION_* reads.

## Recommended References

- active/missions/public/MSN-FOUNDATION-CONFIG-20261108/evidence/implementation-report.md
- active/missions/public/MSN-FOUNDATION-CONFIG-20261108/evidence/test-report.md
- active/missions/public/MSN-FOUNDATION-CONFIG-20261108/evidence/design-spec.json

## Evidence

- active/missions/public/MSN-FOUNDATION-CONFIG-20261108/evidence/implementation-report.md
- active/missions/public/MSN-FOUNDATION-CONFIG-20261108/evidence/test-report.md
- active/missions/public/MSN-FOUNDATION-CONFIG-20261108/evidence/design-spec.json

## Artifacts
