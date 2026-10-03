---
title: Runtime Storage Layout
category: Architecture
tags: [storage, artifacts, workspace, tmp, cache, staging, tier, multi-tenant, retention]
importance: 8
last_updated: 2026-10-03
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
| **artifact** (organization)  | Deliverables owned by an organization (daily digests, org-wide reports)            | `active/organizations/<tier>/<tenant\|shared>/<org>/artifacts/<class>/`                                                       | `writeScopedArtifact({ scope: { organization, tenant? } })`       | review_required — never silently expired                    |
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

### Owner scope (deterministic placement)

A write that belongs to an owner — a mission, task, project or organization —
is placed by the **owner's own record**, never by the caller's guess
(`libs/core/owner-scope.ts`):

| Owner        | Source of tier / tenant / organization                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| mission      | `mission-state.json` where the mission actually lives (any tier, tenant-nested or not)               |
| project      | the project record (`tier`, `tenant_slug`, `organization_id`)                                        |
| organization | its directory `active/organizations/<tier>/<tenant\|shared>/<org>/` (ids are unique per tenant only) |

- `resolveOwnerScope(owner, hint?)` / `resolveMissionDir(id, hint?)`. A caller
  tier/tenant is a **hint that may only narrow**: it may select among same-id
  owners, and it must agree with the owner it resolves to.
- Lookup does not depend on `KYBERION_TENANT`, but visibility does: an identity
  bound to tenant T never resolves another tenant's owner (it reads as not
  found — nothing is disclosed).
- Failures are `OwnerScopeError` with a code and a remedy, rendered
  `[CODE] what — why | next: remedy`:
  `OWNER_NOT_FOUND` (no guessed directory is ever created),
  `OWNER_AMBIGUOUS` (same id in several tenants — pass tier/tenant),
  `SCOPE_CONTRADICTS_OWNER` (with `expected` / `actual`),
  `OWNER_ID_INVALID`.
- `writeScopedArtifact` and `readScopedArtifactIndex` (mission, task, project,
  organization scopes), mission → project links, project operational state and
  the orchestration / task-event / journal mission directories all resolve
  through it. Session, tenant and system scopes have no owner record and keep
  their explicit (or default) tier.
- `findMissionPath` / `loadState` answer from the same resolver for an existing
  mission (owner-scope registers itself as path-resolver's mission locator);
  their directory scan only finds a pre-materialized mission that has no
  `mission-state.json` yet. An id in several tenants fails closed
  (`OWNER_AMBIGUOUS`) instead of returning the first match, and a mission
  directory whose state this process may not see fails with
  `OWNER_NOT_VISIBLE` rather than reading as absent (which would invite a
  second copy). Identity resolution treats both as "no mission identity".
- **Strict vs lenient lookup.** `findMissionPath` is the _strict_ lookup and
  every caller is pinned to a reason in `tests/mission-lookup-boundary.test.ts`:
  _lifecycle_ (mutation / governance / operator tooling: the structured refusal
  is reported), _scope-derivation_ (tier, tenant, visibility or classification
  is derived from the mission, and "absent" would be a looser default, so it
  must fail closed) and _placement_ ("absent" would mean another location or a
  second copy). Only a path where absent is a conservative no-op — an optional
  evidence write, a report row, "no mission identity" for a permission check —
  uses `missionPathOrNull(findMissionPath, id)` from `@agent/core/mission-lookup`,
  which treats `OWNER_AMBIGUOUS` / `OWNER_NOT_VISIBLE` as absent. A new direct
  caller fails the boundary test until it is registered with its category.
- Agent input (surface `steer:` / `follow-up:`, `enqueueMissionAgentInput`) is
  queued beside the existing mission only; input for an unknown mission is
  refused with `OWNER_NOT_FOUND` rather than parked where it would never be read.

The artifact ownership registry (`active/shared/runtime/artifacts/registry.jsonl`)
is append-only; its current state is the **latest row per `artifact_id`**.
Queries de-duplicate before filtering, so a superseded row (e.g. a mission
deliverable since promoted to its project) never matches its old owner. The
storage janitor compacts the file to the latest row per artifact **and owner**,
so offboarding still sees every scope that ever owned an artifact.

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
`publish.task_session_id`; an organization scope owns its record through
`organization_id`. Chronos `mission-asset` serves files under the artifact
floor, mission, project and organization trees, and derives tier / tenant from
the partition (system → public) or the `<tier>/<tenant>/` path segments.

### Mission → project promotion

When a mission linked to a project (`relationships.project`) finishes, its
published `report` / `export` scoped artifacts are **copied** into the project
(`<projectDir>/artifacts/<class>/missions/<MISSION_ID>/<name>`) and their
ArtifactRecords re-pointed there (`metadata.promoted_from`, `promoted_at`), so
the project keeps the deliverable after the mission is archived. Placement
follows the **project record** (its tier and tenant), and only a mission inside
that scope promotes (otherwise `reason: scope_mismatch`); the source must be a
regular file inside the mission's own `artifacts/` tree. The original
stays in the mission tree and moves to the archive with it; `evidence` stays
with the mission. Promotion is best-effort and idempotent
(`libs/core/mission/mission-artifact-promotion.ts`); the outcome is recorded in
the mission state `context.mission_artifact_promotion`.

### Organization digest

`core:organization_digest` with `persist: true` (on in
`pipelines/organization-daily-digest.json`) files each organization's entry as
a published report in that organization's own scope
(`…/<org>/artifacts/report/digests/<YYYY-MM-DD>.json`). The cross-tenant digest
itself is never stored as one file, so a tenant viewer only sees its own
organizations' digests.

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
- `libs/core/owner-scope.ts` — owner-derived scope (`resolveOwnerScope`, `resolveMissionDir`)
- `libs/core/workforce/artifact-store.ts` — `writeScopedArtifact`
- `knowledge/product/governance/storage-retention-catalog.json` — TTLs
- `knowledge/product/governance/security-policy.json` — `tenant_scope`
- [multi-tenant-operations](./multi-tenant-operations.md) ·
  [entity-scope-hierarchy](./entity-scope-hierarchy.md) ·
  [project-mission-artifact-service-model](./project-mission-artifact-service-model.md)
