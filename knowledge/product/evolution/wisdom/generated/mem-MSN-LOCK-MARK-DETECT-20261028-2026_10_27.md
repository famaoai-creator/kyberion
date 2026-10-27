---
record_id: mem-MSN-LOCK-MARK-DETECT-20261028-2026_10_27
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-LOCK-MARK-DETECT-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T17:47:40.187Z
source_branch: fix/lock-mark-detect-20261028
source_commit: 090ba62c1f1e7dab89e67175a1b29450db74808e
---

# Branch repair advice on the verifier's failure reason

A detection surface that proposes a destructive repair must branch on why verification failed, not on a boolean: an unverifiable proof is not evidence of tampering.

## Hint Scope

mission

## Trigger Phrases

- Design rule for integrity detection: a boolean verifier (isTaskVerifiablySuperseded) maps both 'the record is forged' and 'the proof could not be read' (proof_unreadable:*) to false. Any operator-facing surface that turns that result into repair advice (restore a lock, delete a mark) must carry the failure reason and branch: an unreadable proof means fix the store and re-check, never apply the destructive repair. Companion rules: compute counts and lists from one memoized evaluation of an I/O-backed predicate so they cannot disagree; echo worker-writable fields to operators only through a strict id charset (they are an injection surface for LLM operators).

## Recommended References

- active/missions/public/MSN-LOCK-MARK-DETECT-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-LOCK-MARK-DETECT-20261028/evidence/retrospective.md
- active/missions/public/MSN-LOCK-MARK-DETECT-20261028/evidence/reviews/self_review-code-review-r1.json

## Evidence

- active/missions/public/MSN-LOCK-MARK-DETECT-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-LOCK-MARK-DETECT-20261028/evidence/retrospective.md
- active/missions/public/MSN-LOCK-MARK-DETECT-20261028/evidence/reviews/self_review-code-review-r1.json

## Artifacts
