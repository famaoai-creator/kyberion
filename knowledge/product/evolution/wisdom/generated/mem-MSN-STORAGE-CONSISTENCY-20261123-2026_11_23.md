---
record_id: mem-MSN-STORAGE-CONSISTENCY-20261123-2026_11_23
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-STORAGE-CONSISTENCY-20261123-2026_11_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-23T05:14:27.203Z
source_branch: fix/storage-consistency-20261123
source_commit: d27705a94514c802af54bcae262dec39b40f05b7
---

# Fixing reverse-spec findings in destructive storage paths

Reverse-spec claims that the independent verifier confirmed by reading the code reproduced as real defects. Fixing them safely needed tests written first and several independent review rounds, because each fix in a deletion, offboarding or attribution path brought up a new edge case.

## Hint Scope

mission

## Trigger Phrases

- Lessons from MSN-STORAGE-CONSISTENCY-20261123, which fixed the findings of MSN-REVERSE-SPEC-STORAGE-20261123:

1. Inferred reverse-spec claims that the independent verifier confirmed by reading the code all reproduced as failing tests. Treat them as defect reports and write the repro test before the fix.
2. Checking whether a CLI flag was given breaks if any wrapper layer has a default parameter. mission_controller, mission-lifecycle-service and mission-system all defaulted missionType to 'development', so the new MISSION_TYPE_MISMATCH guard would have refused every non-development start. Remove the defaults on that path and test end-to-end through the facade, not only the pure helper.
3. The active and archived mission trees have different layouts. Active missions live at <tier>/<tenant>/<id>. Archived missions live at <tier>/<tenant|shared>/<id>, with an ephemeral tier and legacy flat <id> directories. Enumerate them with path-resolver's layout (archivedMissionsRoot, ARCHIVE_TIER_DIRS); a hand-written scan undercounts lineages and can attribute another tenant's data.
4. Audit-first expiry (write the record, then delete; keep the file if the record fails) only works if every scanner reports the kept files. Otherwise a persistent audit outage leaves a clean report. Treat a file that is already gone as a no-op, not an error.
5. A built-in retention fallback must be pinned to the shipped catalog by a test that compares every field and covers every root it acts on. A partial pin let the fallback delete more than the catalog would.
6. Splitting a large module (scope-offboarding.ts) into lineage and vault modules kept the max-file-lines and type-ratchet gates green without changing behavior.

## Recommended References

- active/missions/public/MSN-STORAGE-CONSISTENCY-20261123/evidence/implementation-report.md
- active/missions/public/MSN-STORAGE-CONSISTENCY-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-STORAGE-CONSISTENCY-20261123/evidence/test-report.md

## Evidence

- active/missions/public/MSN-STORAGE-CONSISTENCY-20261123/evidence/implementation-report.md
- active/missions/public/MSN-STORAGE-CONSISTENCY-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-STORAGE-CONSISTENCY-20261123/evidence/test-report.md

## Artifacts
