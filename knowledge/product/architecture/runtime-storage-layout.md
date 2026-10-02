---
title: Runtime Storage Layout
category: Architecture
tags: [storage, artifacts, workspace, tmp, cache, staging, tier, multi-tenant, retention]
importance: 8
last_updated: 2026-10-02
runtime_stages: [alignment, execution, review]
---

# Runtime Storage Layout

Where runtime data lives under `active/`. Every write is placed by two
questions, never by habit:

1. **Purpose** — how long does it live, and who may delete it?
2. **Partition** — who owns it: the platform (`system`), or a tier/tenant?

`active/shared/tmp/` is the answer to exactly one purpose (scratch). Writing a
deliverable, a workspace, a cache, or an inbound file there loses its owner,
its tier, and its retention — the 24h janitor deletes it, and surfaces never
see it.

## 1. Purpose → place

| Purpose                      | What belongs there                                                                 | Place                                                                                                                         | API                                                               | Retention                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| **scratch**                  | Intermediates and IPC handoffs a single run creates and consumes                   | `active/shared/tmp/<partition>/<domain>/`                                                                                     | `resolveStorageFloor('scratch', …)`                               | 1 day, delete                                               |
| **staging**                  | External files copied in for perception / ingest                                   | `active/shared/staging/<partition>/<domain>/<job>/`                                                                           | `resolveStorageFloor('staging', …)`                               | 3 days, delete                                              |
| **cache**                    | Derived, re-generable data: digest-keyed sidecars, model / build trees, indexes    | `active/shared/cache/<partition>/<domain>/`                                                                                   | `resolveStorageFloor('cache', …)`                                 | 30 days per partition, delete (a miss only costs a rebuild) |
| **workspace**                | Directories a worker operates in: clones, sandboxes, browser profiles, device runs | `active/shared/runtime/workspaces/<id>/`                                                                                      | `createScratchWorkspace` (workforce/workspace-ledger.ts)          | lease + ledger sweep                                        |
| **artifact** (scope-owned)   | Deliverables, reports, evidence, exports of a mission / task / project / session   | `<missionDir>/artifacts/<class>/`, `<projectDir>/artifacts/<class>/`, `active/shared/runtime/session/<id>/artifacts/<class>/` | `writeScopedArtifact({ scope: { mission / project / … } })`       | closes with its scope (mission-artifact-closure)            |
| **artifact** (tenant/system) | Deliverables owned by a tenant or by the platform, with no narrower scope          | `active/shared/artifacts/<partition>/<class>/`                                                                                | `writeScopedArtifact({ scope: { tenant } })` / `{ system: true }` | review_required — never silently expired                    |
| **state**                    | Durable registries, cursors, quotas, pending flows — anything that must survive    | `active/shared/runtime/<domain>/` (+ `physicalScopedPath` for tenant namespaces)                                              | governed catalogs / `writeGovernedArtifactJson`                   | per retention-catalog entry                                 |
| **log**                      | Audit, process, surface, trace logs                                                | `active/shared/logs/`                                                                                                         | `logger`, audit chain                                             | 30 days                                                     |

Decision rule for the boundary cases:

- Must it survive the run that wrote it? Not scratch.
- Can it be rebuilt from inputs? Cache. Can't be rebuilt? State (or artifact).
- Will a person or surface look at it? Artifact — and publish it (§3).
- Does a process `cd` into it, or does it outlive one write? Workspace.

## 2. Partitions — system, tier, tenant

The floors (`tmp`, `staging`, `cache`, `artifacts`) share one partition rule
(`libs/core/storage-layout.ts`):

| Partition        | Segment                 | Holds                                                        | Enforcement                                                                                  |
| ---------------- | ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| system-wide      | `system/`               | Platform data that carries **no** tenant or personal content | none beyond default policy (public tier)                                                     |
| tier, untenanted | `<tier>/shared/`        | Tier data with no tenant binding (single-operator installs)  | tier-guard read gate for `personal` / `confidential`; tenant-bound personas are denied       |
| tier + tenant    | `<tier>/<tenant-slug>/` | Tenant data                                                  | tier-guard read gate + `tenant_scope.protected_prefixes` (cross-tenant deny, broker audited) |

- The order matches the rest of `active/` (`missions/<tier>/<tenant>/`,
  `projects/<tier>/<tenant>/`): tier first, then tenant. Reserved scope names
  (`public`, `confidential`, `personal`, `shared`) are never tenants.
- `system` is the floor-level equivalent of an event scope with
  `scope_kind: 'system'`. Never put tenant or personal data in it.
- Read grants on a floor root or an `active/shared` ancestor (for example the
  long-standing `active/shared/tmp/` grants) cover legacy, `system/` and
  `public/` data only. Reading a `personal/` or `confidential/` partition needs
  a grant that names `<floor>/<tier>/` (the Chronos roles hold
  `active/shared/artifacts/{personal,confidential}/`) or a deliberately broad
  `active/`-level grant; tenant scope then narrows it to the viewer's tenant.
- Unpartitioned files at a floor root keep their owner's lifecycle (for
  example knowledge-index `cache/ki-*.json`, evicted by its own LRU).
- Scope-owned artifacts inherit the tier and tenant of their owner directory
  (a confidential tenant mission's artifacts live under
  `active/missions/confidential/<tenant>/<id>/artifacts/`).
- A path directly under a floor root without a partition segment is
  **legacy**: it predates this layout and carries no governing tier.

## 3. Surface visibility

Surfaces (Chronos deliverable inbox, mission-asset preview) list
**ArtifactRecords** (`active/shared/runtime/artifacts/<id>.json`), not
directories. A deliverable meant for people must be published:

```ts
writeScopedArtifact({
  scope: { mission: 'MSN-…' }, // or project / tenant + owner
  artifact_class: 'report',
  name: 'weekly/summary.md',
  content,
  publish: { kind: 'report', preview_text: 'Weekly summary' },
});
```

`publish` registers the record with the scope's tenant / project / mission
refs and `metadata.tier`, so the viewer scope (tenant + tier) is resolved
server-side. ArtifactRecords must have an owner (project, mission, or task
session); tenant- or system-scoped artifacts name it with
`publish.task_session_id`. Chronos `mission-asset` serves files under the
artifact floor and derives tier / tenant from the partition (system → public).

## 4. Migration status

- New code places data with this table; `sharedTmp()` call sites are frozen by
  `tests/shared-tmp-ratchet.test.ts` (ledger:
  `knowledge/product/governance/shared-tmp-allowlist.json`), and
  `active/shared/tmp` string literals in `pipelines/` are frozen by the same
  test's pipeline-literal ledger.
- `migrate-candidate` ledger entries are the work list. Priority: data that
  must outlive the 24h TTL (build trees, OAuth flows, reconcile registries,
  voice samples) → deliverables (move to `writeScopedArtifact` + `publish`) →
  inbound staging (perception CLIs).
- Legacy `outputs/` and `work/` at the repo root are outside this layout; new
  deliverables go to scoped artifacts instead.

## References

- `libs/core/storage-layout.ts` — floor resolver and classifier
- `libs/core/workforce/artifact-store.ts` — `writeScopedArtifact`
- `knowledge/product/governance/storage-retention-catalog.json` — TTLs
- `knowledge/product/governance/security-policy.json` — `tenant_scope`
- [multi-tenant-operations](./multi-tenant-operations.md) ·
  [entity-scope-hierarchy](./entity-scope-hierarchy.md) ·
  [project-mission-artifact-service-model](./project-mission-artifact-service-model.md)
