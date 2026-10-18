---
record_id: mem-MSN-HARNESS2-IMPORT-20261018-2026_10_18
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HARNESS2-IMPORT-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T03:04:42.908Z
source_branch: feat/harness2-distill-import-20261018
source_commit: 368d53f6ff159bbcdc284f4cce4be4b30d1e2d51
---

# Evidence-gated lesson contract for mission distillation

Mission distillation now emits an optional experience record {cue,lesson,evidence,confidence} plus per-change attribution rows with a confounded verdict; the promotion queue carries and flags them so weak lessons are narrowed or declined instead of promoted.

## Hint Scope

mission

## Trigger Phrases

- Adopted harness2's experience contract: a lesson is promotable only when it names (a) the shape of situation it applies to (cue, not task facts), (b) the operation on a named component (lesson), (c) the edit rows it rests on (evidence), and (d) a confidence level. Per-change rows take verdicts helped|hurt|no_observed_effect|confounded — prefer confounded over invented attribution when several components changed at once. A lesson resting only on confounded rows is a guess: narrow it or omit experience entirely (NO_ENTRY is valid). Facts verified in a workspace are task-scoped anchors and do not promote; transferable procedure does. When no complete experience is emitted, the candidate is flagged distill_experience_declined and the review warns; low-confidence lessons warn to narrow or decline; brokered cross-tier promotions warn that free-text lesson fields may carry tenant detail.

## Recommended References

- active/missions/public/MSN-HARNESS2-IMPORT-20261018/evidence/distillation.md
- active/missions/public/MSN-HARNESS2-IMPORT-20261018/evidence/implementation-report.md
- active/missions/public/MSN-HARNESS2-IMPORT-20261018/evidence/test-report.md

## Evidence

- active/missions/public/MSN-HARNESS2-IMPORT-20261018/evidence/distillation.md
- active/missions/public/MSN-HARNESS2-IMPORT-20261018/evidence/implementation-report.md
- active/missions/public/MSN-HARNESS2-IMPORT-20261018/evidence/test-report.md

## Artifacts
