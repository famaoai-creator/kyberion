---
category: Security
---

- **Tenant isolation for team channel turns (Team Channel E)**:
  - **Tool-less agent**:
    - A `team` channel turn runs on its own surface runtime for each tenant and tier (`<agent>--tenant-<slug>--<tier>`).
    - The runtime is launched from an empty working directory with every tool, MCP server, setting source and slash command disabled. The owner's CLAUDE.md, auto-memory, hooks and plugins therefore never reach it.
    - If a provider, backend or the supervisor daemon cannot do this, the runtime does not start (`TOOL_LOCKDOWN_UNSUPPORTED`). A runtime with the same name that was started with tools is not reused (`TOOL_LOCKDOWN_MISMATCH`).
  - **No side channels**: team turns never open task sessions or delegate over A2A. They also skip intent compilation, the background-review fork and intent-learning records. Real work goes through tenant-scoped mission proposals.
  - **Tenant-bound reads**: the Slack bridge binds the channel's tenant for the turn. Of tenant data, it can read only that tenant's confidential knowledge and its tenant profile. It also keeps its existing read access to the member registry, which is needed to resolve speakers.
  - **Knowledge answers**: answers draw on public knowledge plus the channel's tenant (public only when the channel tier is `public`). The owner's calendar and location are not answered in shared channels.
  - **Knowledge scanner fix**: the scanner now checks for symlinks without needing read access to parent directories. A reader scoped to one tenant can therefore index its own subtree, and symlinks are still rejected at every level.
