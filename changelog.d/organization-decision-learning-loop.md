---
category: Added
---

- **Organization decision approval requests**: `pnpm organization decision transition --record-status pending_approval --request-approval --chosen-option <option>` opens the human-only approval request that `--record-status approved|rejected --approval-ref <channel:id>` later verifies. The request is bound to the decision, its tier/tenant/organization and the proposed option; approving with a different `--chosen-option` is refused, and a human denial settles the decision as `rejected`. Decide on an authenticated surface (Chronos / concierge); `pnpm kyberion approvals --approve` is not accepted as decision evidence.
- **Organization learning lifecycle**: `pnpm organization learning transition --record-status approved|rejected|promoted` moves learning candidates past `proposed`. Rejection needs `--reason`; promotion needs `--promoted-ref` to an existing `knowledge/` document in the same tier and tenant. `organization status` shows proposed and approved-but-unpromoted learnings with the next command.
