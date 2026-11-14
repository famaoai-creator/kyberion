---
title: Canonical Entity Scope Hierarchy
tags: [architecture, governance, tenant, organization, project, mission, task, session]
last_updated: 2026-11-14
concepts: [entity-scope, tenant, organization, project, work-shape, execution-shape, task-session]
---

# Canonical Entity Scope Hierarchy

Kyberion has one containment hierarchy:

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
```

The executable declaration is `libs/core/entity-scope.ts`
(`ENTITY_SCOPE_HIERARCHY`); this document is the human-facing explanation and
storage mapping. The chain is the identity layer of the runtime scope
envelope — see [scope-governance-plane](./scope-governance-plane.md) for how
workspace isolation and the control plane project onto it.

Required references depend on the record's contract; the chain does not make
every reference mandatory. When `organization_id` is present it is always inside
the tenant boundary. A `WorkItemContext` carries the applicable references
through `task_id`, and the writer normalizes their serialized order to this
hierarchy; JSON key order is not an authorization mechanism.

The `knowledge/personal/stances/{slug}/` overlay selected by `KYBERION_STANCE` is **not** a level
in this hierarchy. It is a stance — runtime configuration for which entity
Kyberion is acting as — and is deliberately orthogonal to scope
([stance-tenant-customer-model](./stance-tenant-customer-model.md)).

## Scope references and execution choice

The chain orders references from the widest boundary to the narrowest execution
context. It is not a requirement to create every level for each request. Scope
answers whose work and information are involved; Execution Shape answers how the
request runs. Work Shape classifies the work itself (for example,
`routine_operation`); it is not an Execution Shape.

| Case                         | Applicable references and execution                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal conversational work | A Task Session can run without a tenant or project. Its `project_context` is optional. Personal custody and authorization still apply.                   |
| Standalone repository work   | A public-tier mission can run without a tenant or managed project. Its Tasks belong to that mission.                                                     |
| Project work                 | A project can group missions and task sessions; a Task Session is not a mandatory parent of a mission Task.                                              |
| Tenant organization work     | References, when present, belong within the authorized tenant. A routine operation does not become a mission merely because it has organization context. |

The executable boundaries are distinct:

- `ENTITY_SCOPE_HIERARCHY` declares the full ordering, including `session`.
- `WorkItemContext` (`libs/core/workforce/work-coordination-types.ts`) has optional
  references through `task_id` and an optional `work_shape`; it has no `session`
  field. `normalizeWorkItemContext` supplies `project_id: 'default'` and
  `work_shape: 'routine_operation'` when absent. The default project bucket is
  not evidence of a governed managed Project record.
  New WorkItems store `context_origin` beside `context`: each default-bearing
  field is `explicit` (supplied by the facade caller) or `default`. This does
  not establish that a human chose it or that a referenced entity was verified.
  Unchanged fields retain their origin on
  update; changed values are explicit. Readers expose these as `field_sources`;
  a missing origin is `unknown`. Legacy migration preserves known origins and
  leaves restored fields unknown, rather than reconstructing intent from values.
  Provenance is descriptive metadata and grants no access.
- `TaskSession` (`libs/core/task/task-session.ts`) is the lighter durable work
  record, with its own `session_id` and optional `project_context`. The chain's
  `session` key names execution lineage, not a required Task Session parent.

Optional references do not authorize omitted scope. Confidential work still
requires its real tenant; a supplied organization, project or mission reference
must satisfy the owning facade's scope checks. Neither a `default` project
bucket nor missing tenant metadata permits cross-tenant access. See
[Units of work](../../../docs/GLOSSARY.md#units-of-work) for WorkItem ownership
and the mission/task relationship.

## Consumers

| Consumer              | Rule                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| Storage               | `active/{organizations,projects,missions}/{tier}/{tenant}/...`            |
| Authorization         | Resolve the tenant first; client parameters may only narrow it            |
| Work items            | Persist references in typed `context`, never labels or metadata fallbacks |
| Artifacts             | Persist `tenant_slug` and `organization_id` with the ownership record     |
| Retention/offboarding | Query ownership and registry records before path traversal                |
| Identity              | `AgentIdentity.affiliation.tenant_slug` is the boundary claim; the NHI id |
|                       | carries it too: `kyberion://agent/<tenant>/<org\|_>/<slug>`               |
| Organization profile  | Per organization: `knowledge/confidential/{tenant}/organizations/{org}/`  |

Concept Model v2 D3 (Tenant 1:N Organization): an NHI belongs to a tenant and
optionally to one organization inside it, so its id is
`kyberion://agent/<tenant>/<org|_>/<slug>` (`libs/core/contracts/nhi-id.ts`).
The tenant is required — `buildNhiId` rejects a missing tenant and a reserved
scope name — and the old `'default'` organization fallback is gone (`_` means
"no organization"). An organization is never named without its tenant; an
identity with no tenant at all (person-scope agents) is the interim
`kyberion://agent/_/_/<slug>`. Pre-D3 `kyberion://agent/<org>/<slug>` ids
resolve as aliases for one release after `pnpm nhi migrate-ids --apply`.
Organization profiles follow the same chain: one per organization under the
tenant home; the tenant-root `organization-profile.json` is a one-release
fallback (migration `0004-organization-profile-home`).

`shared` is an explicit public/shared storage partition. It is not a tenant
and must not satisfy the required `tenant_slug` field for confidential data.
The same reasoning applies to the tier names, so tier and partition are an
orthogonal axis to tenancy and no value of one may satisfy the other. This is
executable, not advisory: `RESERVED_SCOPE_NAMES` in `entity-scope.ts` lists
`public` / `confidential` / `personal` / `shared`, and `assertTenantSlug()` /
`resolveCurrentTenantSlug()` reject them — see
[EG-14](../../../docs/developer/improvement-plans-archive/2026-08/EG-14_TIER_NAME_AS_TENANT_SLUG.ja.md)
for the drift that motivated it, in both directions (a partition name taking a
tenant's seat, and a tenant's state falling into a partition's place).

Every writer must validate the referenced parent records before committing a
child. Readers must not create missing directories as a side effect; creation
belongs to the governed writer and must use `secure-io`.

## Knowledge and learning

ナレッジもイベント・ledger と同じ containment chain を使う。`ScopeContext` から
positive allowlist を解決し、未指定の reader は `knowledge/public` と
`knowledge/product` だけを読める。confidential / personal は tenant と必要な
entity prefix が一致した物理 namespace に限り、system-wide scan は明示的な
system authority がある場合だけ許可する。`knowledge/personal/stances/{slug}/` は引き続き stance
overlay であり、public knowledge の代替ではない。

feedback delivery/usage、intent memory/learning、promotion ledger、HINTS、
compaction summary、tenant distill は `tenants/{tenant}` 下の scope 区画へ保存する。
legacy の unscoped 記録は tenant 記録として推測せず `unscoped-legacy` lane として
分離する。context pack は `compileScopedContextPack` の rejection を経てから供給し、
ranking は同一 task/mission/project/org/tenant を近接優先する。このため、knowledge
の再利用・学習・蒸留も tenant をまたいだ暗黙の共有を行わない。

## Events and ledgers

イベントと ledger も同じ containment chain を持つ。新規レコードは flat な
`tenant_slug` / `mission_id` だけでなく、次の `scope` を持つ。

```json
{
  "scope_kind": "task",
  "tier": "confidential",
  "tenant_slug": "acme-corp",
  "organization_id": "acme-platform",
  "project_id": "PRJ-1",
  "mission_id": "MSN-1",
  "task_id": "TASK-1"
}
```

`scope_kind: system` は tenant を持たないシステム全体の記録を表し、
`public` や `shared` を擬似 tenant として利用しない。既存 JSONL の flat
形式は読み取り互換とするが、tenant / organization / entity の viewer は
canonical `scope` がない記録を自分の tenant の記録として推測してはならない。

| 記録                  | 正本                                            | 表示・検索                                                  |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| システム全体の監査    | `active/shared/logs/audit/` の hash chain       | system scope の audit reader                                |
| tenant/entity の監査  | 上記 master chain + 既存 customer stance mirror | `tenant_slug` と `scope` の一致を検証                       |
| ミッション実行 ledger | mission-local `execution-ledger.jsonl`          | mission/task scope、tenant view は scope 必須               |
| 協調イベント          | mission-local / shared redacted event stream    | `agent-collaboration-projection` が scope filter 後に再生成 |

projection は書き込み正本ではない。system view は system-wide metadata を表示できるが、
tenant view は対象 tenant と scope chain が一致するレコードだけを表示し、cross-tenant
集計は brokered read と audit event を経由する。offboarding では event/ledger を無断で
消去せず、tenant の受け入れ停止・projection 停止・保持/Export を先に行う。
