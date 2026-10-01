---
category: Security
---

- **Tenant isolation for team channel turns (Team Channel E)**:
  - **Tool-less agent**: a `team` channel turn runs on a separate surface runtime for each tenant (`<agent>--tenant-<slug>`). That runtime is launched with every tool and MCP server disabled. If a provider or backend cannot disable tools, the runtime does not start (`TOOL_LOCKDOWN_UNSUPPORTED`).
  - **No direct work routes**: team turns never open task sessions or delegate over A2A. Real work goes through tenant-scoped mission proposals.
  - **Tenant-bound reads**: the Slack bridge binds the channel's tenant for the turn. It can read only that tenant's confidential knowledge and its tenant profile.
  - **Knowledge answers**: answers draw on public knowledge plus the channel's tenant (public only when the channel tier is `public`). The owner's calendar and location are not answered in shared channels.
  - **Knowledge scanner fix**: the scanner now checks symlinks without needing read access to parent directories, so a reader scoped to one tenant can index its own subtree.
