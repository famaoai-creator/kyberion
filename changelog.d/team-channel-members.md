---
category: Added
---

- **Team channel speakers resolve to organization members (Team Channel P1)**: Kyberion now identifies Slack speakers in `team` channels through the member registry. Link a Slack user to a member with `pnpm organization member link-identity <member-id> --slack <user-id>`. The member's role on the channel tenant decides what they can do:
  - owner and approver: decide approvals
  - owner and operator: request work
  - viewer: ask questions only

  Unregistered actors on the allowlist can only ask questions. An identity bound to a suspended member is refused. Approvals now record the member principal (`user:<member_id>`).
