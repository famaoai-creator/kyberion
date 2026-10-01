---
type: change
pr: '848'
category: fix
summary: Separate organization_id from customer stance; tenant-aware mission dirs; short ops-report process; mission-id execution refs.
---

Dogfood of SNS community ops exposed four flow frictions:

1. `--organization-id` remapped to `KYBERION_CUSTOMER` and hid personal identity.
2. `mission kickoff` failed mkdir of bare `active/missions/confidential` under tenant policy.
3. Default `development` process expanded ops reports into `code-change-aidlc`.
4. Organization operation run `--execution-ref` rejected bare mission ids.

Fixes: stance-gated customer switch, tenant-scoped prerequisite dirs,
`operations_report` → `organization-ops-report` (draft/record/review), and
mission-id resolution to `mission-state.json`.
