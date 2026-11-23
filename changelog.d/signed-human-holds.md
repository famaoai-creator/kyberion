---
category: Changed
---

- **Required human holds on mission gates are now decided by a person through an approval.** `mission gate-pass <ID> <GATE_ID> --request-approval` files a human approval for that gate, bound to the mission, the gate and a fingerprint of the gate inputs. The person approves it with `pnpm kyberion approvals --approve <id>`, and `gate-pass <ID> <GATE_ID> --approval-request-id <id>` passes the gate. The pass is signed in the approver's name (`signHumanOverride`) and recorded under `gates/human-holds/`.
  - A gate check `human_override` with `params.require_signature: true` is a required hold. These gates are marked: reverse_spec `REVERSE_SPEC_SCOPE_CONFIRMED` and `CODE_GRAPH_FROZEN`, and legacy_migration `MIGRATION_STRATEGY_APPROVED`. A required hold is enforced whatever `KYBERION_GATE_OVERRIDE_SIGNATURE` is set to; the default for every other gate is unchanged.
  - Until a required hold is approved:
    - `record-evidence` and `review-task` record evidence for later-phase tasks but do not complete or cascade them;
    - `finish` is blocked;
    - `gate-pass` without an approval is refused.
  - Editing the gate inputs after approval needs a new approval.
  - Any other gate with a `human_override` check can use the same approval path; the pass then carries a verifiable signature.
