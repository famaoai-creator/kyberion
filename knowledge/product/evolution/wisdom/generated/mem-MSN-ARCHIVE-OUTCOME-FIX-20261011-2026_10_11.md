---
record_id: mem-MSN-ARCHIVE-OUTCOME-FIX-20261011-2026_10_11
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ARCHIVE-OUTCOME-FIX-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T01:52:39.756Z
source_branch: fix/surface-artifact-visibility-20261011
source_commit: 831b0ecbace4ae400a51dc5370f61effd140645a
---

# Mission archive durability: refs, owner resolution, and publish metadata

Rules for keeping mission-owned files and records reachable across the finish-time archive move.

## Hint Scope

mission

## Trigger Phrases

- (1) The finish archive move changes every path under a mission dir — anything that stores in-mission refs (inbox entries, records, face paths) must be repointed right after the move or resolved against the archived dir. repointMissionInboxPaths rewrites artifact_paths and role evidence_refs together because exact-match validation binds them. (2) When rebuilding an owner scope for an archived mission, reconstruct it from the preserved mission-state.json and keep every downstream check (tier, tenant, org, member) identical — the fallback triggers only on OWNER_NOT_FOUND, never on ambiguity. (3) Remapping out-of-tree stored paths must be gated on the owner actually living at the archived location — an unconditional /<id>/ tail remap lets a ref naming another tenant partition rebind into the local dir. (4) Deck-kind artifact records need metadata.slides_count for the finish quality gate; stamp it at publish from the pptx container (ppt/slides/slideN.xml parts) so callers never hand-derive it — caller-provided metadata still wins. (5) The flat active/archive/missions/ layout is not a tenant_scope protected_prefix — app-layer checks are the only gate on archived confidential content; treat any read path there as authorization-critical.

## Recommended References

- active/missions/public/MSN-ARCHIVE-OUTCOME-FIX-20261011/evidence/implementation-report.md
- active/missions/public/MSN-ARCHIVE-OUTCOME-FIX-20261011/evidence/design-spec.json

## Evidence

- active/missions/public/MSN-ARCHIVE-OUTCOME-FIX-20261011/evidence/implementation-report.md
- active/missions/public/MSN-ARCHIVE-OUTCOME-FIX-20261011/evidence/design-spec.json

## Artifacts
