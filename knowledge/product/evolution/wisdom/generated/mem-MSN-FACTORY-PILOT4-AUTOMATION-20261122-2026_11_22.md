---
record_id: mem-MSN-FACTORY-PILOT4-AUTOMATION-20261122-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FACTORY-PILOT4-AUTOMATION-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T13:39:48.012Z
source_branch: agent/factory-pilot4-automation
source_commit: 480c12918ab92b7d2dd881fd30cfd87a8125a134
---

# Factory automation: publish commands delegate, violation types live in the catalog

Two reusable rules from Pilot #4: (1) a mechanical publish command should do only the git plumbing and delegate PR creation to the governed path so readiness/KL-03/approval gates cannot be bypassed or drift; (2) typed deny classes belong in the governed error-classifier catalog ordered specific-before-broad, not in consumer-side message matching.

## Hint Scope

mission

## Trigger Phrases

- Commands that publish generated artifacts (weekly reports, snapshots) should fail closed: refuse on unrelated tracked modifications, add only the artifact file, restore the caller branch in finally, and spawn the governed pr create so every publication carries the same human approval. Policy-violation consumers should classify via explainPolicyViolation().violationType with the pattern in error-classifier-rules.json inserted before broader types — never discriminate on raw message substrings. Operational parsing note: git status --porcelain lines carry a two-column status prefix; trimming whole-command output eats the first line. A --dry-run flag exercised live catches real bugs in fail-closed guards before any side effects occur.

## Recommended References

- active/missions/public/MSN-FACTORY-PILOT4-AUTOMATION-20261122/evidence/implementation-report.md
- active/missions/public/MSN-FACTORY-PILOT4-AUTOMATION-20261122/evidence/test-report.md
- active/missions/public/MSN-FACTORY-PILOT4-AUTOMATION-20261122/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-FACTORY-PILOT4-AUTOMATION-20261122/evidence/implementation-report.md
- active/missions/public/MSN-FACTORY-PILOT4-AUTOMATION-20261122/evidence/test-report.md
- active/missions/public/MSN-FACTORY-PILOT4-AUTOMATION-20261122/evidence/retrospective.md

## Artifacts
