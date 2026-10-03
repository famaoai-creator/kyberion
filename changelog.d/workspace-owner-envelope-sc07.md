---
category: Changed
---

- **Workspace owner aligned to the scope envelope (SC-07)** — `WorkspaceOwner` is now the shared `Pick<ScopeContext, 'mission_id'|'task_id'|'session_id'>` instead of a parallel shape, and owner resolution goes through `tryResolveOwnerScope` everywhere: the sweep's terminal check resolves the mission dir via owner-scope, and `listWorkspaces` is tenant-scoped — a `KYBERION_TENANT`-bound viewer sees only workspaces whose owner mission resolves to that tenant (unresolvable mission-owned workspaces hide; unbound owners stay visible on the system floor).
