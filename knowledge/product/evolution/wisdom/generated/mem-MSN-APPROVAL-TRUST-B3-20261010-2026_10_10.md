---
record_id: mem-MSN-APPROVAL-TRUST-B3-20261010-2026_10_10
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-APPROVAL-TRUST-B3-20261010-2026_10_10
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-10T15:43:14.301Z
source_branch: feat/human-approval-trust-b3-20261010
source_commit: 88e538c7e9b50a38f121f8e29649acea216249fe
---

# Strong-factor enrollment must be as strong as the assurance it grants

A passkey (A3) path is only as strong as its enrollment and step-up flows: gate enrollment on a non-agent human session, require step-up from an existing usable credential, cool down first credentials, bind step-ups to the session that performed them, and bind the signed challenge to the digest the card displayed.

## Hint Scope

mission

## Trigger Phrases

- Lessons from HA-07/HA-08 (passkey approvals and governed assurance mode):

1. Enrollment is part of the factor. If any session holder can register a credential, a session-level attacker gets the strong factor. Gate enrollment and revocation on a non-agent surface_session principal, require a step-up assertion from an existing usable credential, and give credentials enrolled without step-up a policy-governed cooldown before they can settle high-assurance decisions. Notify the operator on every add/revoke with whether step-up was used and when the credential becomes usable.
2. A per-member step-up is not per-session. Return a single-use random token from step-up verification, store only its hash, and require it on the next enrollment/revoke call so another session of the same member cannot spend it.
3. Sign what was shown. The challenge options call must carry the presented digest from the card and refuse a stale one; computing it from the current server record lets the user sign content they never saw.
4. Pending records need a decision-time floor. When raising required assurance by policy, derive the floor at decision time from the policy rule id and the effect binding (including built-in fallback rules) and take the max with the recorded level; never re-grade decided records.
5. Governed modes must not be loosenable by env: policy sets warn|enforce, env may only tighten, unreadable policy fails closed.
6. Lockfile review evidence for check:lockfile-commit-gate must be a file inside the repo (committed under docs/developer/improvement-plans-_/LOCKFILE_REVIEW__.md) containing the lockfile sha256; files outside the repo root cannot be read by the gate.

## Recommended References

- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/design-spec.json
- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/test-report.md
- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/lockfile-review.md

## Evidence

- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/design-spec.json
- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/test-report.md
- active/missions/public/MSN-APPROVAL-TRUST-B3-20261010/evidence/lockfile-review.md

## Artifacts
