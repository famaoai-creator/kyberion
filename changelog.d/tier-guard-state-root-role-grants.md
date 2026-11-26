---
category: Fixed
---

- **Approved credential grants could not be applied.** The tier guard judged writes and reads under tier-partitioned durable-state roots (e.g. `active/shared/runtime/grants/confidential/<tenant>/`) only against their `knowledge/<tier>/` projection, so an authority role granted the state root by its real path (`credential_allocation_manager`) was refused and the first `reasoning credentials assign` after owner approval failed with a generic error. Role grants that name a state root itself are now matched on the real path, bound to `${KYBERION_TENANT}`; broad ancestors such as `active/shared/runtime/` still do not reach tier data.
- **Organization-operations dots failed every wake with `Unknown reasoning role`.** A delegated dot wake routed on the charter's authority role (e.g. `organization_operator`), which is an authorization identity rather than a reasoning role. `dotReasoningRole` keeps the authority role only when the route policy defines it and otherwise routes the wake (and its live-candidate check) on `default`.
