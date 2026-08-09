---
title: Canonical Entity Scope Hierarchy
tags: [architecture, governance, tenant, organization, project, mission, task, session]
last_updated: 2026-08-09
---

# Canonical Entity Scope Hierarchy

Kyberion has one containment hierarchy:

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
```

The executable declaration is `libs/core/entity-scope.ts`
(`ENTITY_SCOPE_HIERARCHY`); this document is the human-facing explanation and
storage mapping.

`organization_id` may be omitted for shared/public records, but when it is
present it is always inside the tenant boundary. A `WorkItemContext` carries
the same references and the writer normalizes their serialized order to this
hierarchy; JSON key order is not an authorization mechanism.

## Consumers

| Consumer              | Rule                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| Storage               | `active/{organizations,projects,missions}/{tier}/{tenant}/...`            |
| Authorization         | Resolve the tenant first; client parameters may only narrow it            |
| Work items            | Persist references in typed `context`, never labels or metadata fallbacks |
| Artifacts             | Persist `tenant_slug` and `organization_id` with the ownership record     |
| Retention/offboarding | Query ownership and registry records before path traversal                |
| Identity              | `AgentIdentity.affiliation.tenant_slug` is the boundary claim             |

`shared` is an explicit public/shared storage partition. It is not a tenant
and must not satisfy the required `tenant_slug` field for confidential data.

Every writer must validate the referenced parent records before committing a
child. Readers must not create missing directories as a side effect; creation
belongs to the governed writer and must use `secure-io`.
