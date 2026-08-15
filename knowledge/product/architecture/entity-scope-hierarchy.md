---
title: Canonical Entity Scope Hierarchy
tags: [architecture, governance, tenant, organization, project, mission, task, session]
last_updated: 2026-08-12
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

The `customer/{slug}/` overlay selected by `KYBERION_CUSTOMER` is **not** a level
in this hierarchy. It is a stance — runtime configuration for which entity
Kyberion is acting as — and is deliberately orthogonal to scope
([stance-tenant-customer-model](./stance-tenant-customer-model.md)).

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
The same reasoning applies to the tier names, so tier and partition are an
orthogonal axis to tenancy and no value of one may satisfy the other. This is
executable, not advisory: `RESERVED_SCOPE_NAMES` in `entity-scope.ts` lists
`public` / `confidential` / `personal` / `shared`, and `assertTenantSlug()` /
`resolveCurrentTenantSlug()` reject them — see
[EG-14](../../../docs/developer/improvement-plans-2026-08/EG-14_TIER_NAME_AS_TENANT_SLUG.ja.md)
for the drift that motivated it, in both directions (a partition name taking a
tenant's seat, and a tenant's state falling into a partition's place).

Every writer must validate the referenced parent records before committing a
child. Readers must not create missing directories as a side effect; creation
belongs to the governed writer and must use `secure-io`.

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
