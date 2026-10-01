---
category: Added
---

- **Team channel mode for shared Slack channels (Team Channel P0)** — declare a channel as `team` in `KYBERION_SURFACE_CHANNEL_MODES` (`tenant_slug`, `max_tier`, `approvers`). Kyberion then answers only when @mentioned or inside threads it already joined, denies speakers unless an allowlist exists, runs the turn with the channel's tenant scope and a disclosure cap of confidential, and accepts approvals, change requests and mission-proposal decisions only from the channel's approvers. Unlisted channels keep the owner-direct behaviour; customer bindings still take precedence.
