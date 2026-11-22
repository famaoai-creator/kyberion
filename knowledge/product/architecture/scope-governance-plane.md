---
title: Scope Governance Plane
tags: [architecture, governance, scope-envelope, control-plane, approval, taint, workspace]
last_updated: 2026-10-03
roles: [mission_controller, ecosystem_architect]
phases: [execution, review]
---

# Scope Governance Plane

Three scope systems — the entity-scope hierarchy, workspace isolation, and
the cloudflare-os control plane — used to be parallel mechanisms that merely
happened to share `mission_id`. The scope governance plane projects them onto
one governed scope model: a runtime-minted **two-layer envelope** whose
identity every governed record derives from and whose policy only narrows.

## The two-layer envelope

`libs/core/scope-envelope.ts` — `ScopeEnvelope`:

- **Identity layer** — canonical `tenant_slug → organization_id →
project_id → mission_id → task_id` (`ENTITY_SCOPE_HIERARCHY`), minted at
  dispatch boundaries and never trusted from client input.
- **Policy layer** — attenuable policy (`security_scope`, `purpose`, read
  tiers). `policyNarrow` can only shrink: wider tiers, a different tenant or
  mission, or a minted-envelope contradiction all fail closed with
  `[POLICY_VIOLATION]`.

The envelope lives in AsyncLocalStorage; `currentScopeEnvelope()` is what
governance stages read first. Delegation narrows the parent envelope for
the child work item before claim — never widens.

## The one governed flow

```text
dispatch boundary (delegation, actuator, pipeline)
  └─ mintScopeEnvelope / narrowScopeEnvelope        SC-01
        └─ runOpPreflight waterfall                 SC-02/05/06
             core:scope        100  envelope exists + narrows cleanly
             core:effect       110  manifest effect -> governance stamp
             core:introduction 112  write/egress need resource intro
             core:taint        115  egress gets mission taint stamp
             core:provenance-egress 118  taint vs the policy-classified destination
             core:adf-guardrails / provider-egress  120/130
        └─ execute (stamps stripped; they never reach the op schema)
        └─ post-op recordOpObservation              SC-05
        └─ approvals: approval-store is the ONE path  SC-04
             held_effect steering -> held-effect-bridge -> journal
```

Every op's effect class (`none|read|write|egress`) is declared in its
manifest capability (SC-02; `op-effect-coverage` gate enforces 100%). A
pipeline-style capability declares the ops it dispatches internally in
`step_ops` (`system:write_file`, `browser:goto`, …), each with its own
`effect` / `resource_ref_from` / `egress_destination_from`; a step inherits the
capability's declarations, never shadows a declared capability, and an
undeclared step stays `write` (fail-safe).

**Egress destination, not audience claims.** The guard never reads an audience,
tenant or hash the caller states about a payload. It classifies the host the
op actually connects to (`egress_destination_from`) through the egress policy
(`classifyEgressDestination`: tenant-approved host = `personal` for that tenant,
allowlisted = `public`, anything else = `external`), takes the tenant from the
mission, and hashes the content actually sent (`egressPayloadHash`). A tainted
mission whose destination is undeclared is denied.

In enforcement mode, an artifact disclosure exception binds the mission,
payload hash, audience, tenant and canonical HTTP(S) destination, including
the endpoint path and query. A historical exception without a destination
requires new approval. An explicit envelope egress denial applies before
rollout and before any disclosure exception.

Service introductions use the same read/write classification as service
admission. Direct API operations use their dispatch URL and GitHub repository
presets resolve the repository from the execution arguments and preset route.
Enforced mode refuses an unresolved resource or a conflicting resource
reference. A task binding comes from the active envelope.

### 外部操作1件の認可

| 確認すること               | 判定に使う情報                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 所属と対象を確定する       | 実行主体（Member / NHI）の信頼済みコンテキストから Tenant・Project などを確定し、操作の実引数から外部リソースを特定する。                                                                                        |
| 操作と情報の扱いを確認する | 操作の権限、サービス側の資格情報、Tier・開示先・委任時の Scope Envelope をそれぞれ確認する。Scope Envelope の外部送信禁止や有効な停止条件はここで操作を止める。                                                  |
| 個別承認を省けるか確認する | ポリシーが委任を認め、有効な Accountability Charter が対象と操作に一致し、必要な証跡と上限の条件を満たせば、責任者に帰属させて実行できる。                                                                       |
| 個別承認へ進むか決める     | Charter による委任が成立しなくても、操作のポリシーと呼び出し経路が個別承認を認める場合は、確定した操作内容の承認に進む。停止条件に該当する場合や、必要な人間の判断を取得できない場合は実行を保留または拒否する。 |

たとえば GitHub の Draft PR なら、`vcs:pr_create` と対象リポジトリを確認する。
Charter の `external_operations` は事前委任する対象の指定であり、主体に
操作権限を付与する Grant とは責務が異なる。コード上の型名は
`CharterExternalOperationTarget`（互換名 `ExternalOperationGrant`）。
実行境界は読み取り時にも、操作に結び付いたテナントと実行中のスコープを
照合する。登録済みの書き込みが読み取りとして渡された場合は、個別承認を
発行する前に構成エラーとして停止する。会議からの退出など、承認を待たずに
実行すべき後処理はコード側の認可レジストリに明示する。
個別承認を使う場合、PR 公開の証跡はリポジトリ、参照、コミット、本文に結び付く。

**Exactly-once apply.** An approved held effect is executed by the one process
that wins `applyClaim` under the journal lock. A claim with no recorded outcome
is never retried; an authenticated human releases it with
`releaseApplyClaim(id, { …decision, reason })` after verifying the side effect
did not happen. Operator summaries expose the claim.
Stage modes roll out per op family via
`knowledge/product/governance/op-preflight-rollout.json` — `warn` audits
before `enforce` blocks.

## Each mechanism's responsibility on the plane

| Mechanism        | Before                                                        | On the plane                                                                                                                                                |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entity-scope     | context fields copied per record                              | envelope identity; `resolveOwnerScope` derives tier/tenant from the mission dir                                                                             |
| workspace ledger | `WorkspaceOwner` parallel type                                | `Pick<ScopeContext>` subset; orphan/visibility via `tryResolveOwnerScope`; `KYBERION_TENANT`-bound lists filter (SC-07)                                     |
| control plane    | flat `control-plane.json`, per-module instances, lost updates | tenant-namespaced append-only journal per `runtime/<tier>/<tenant>/cloudflare-os/`; `getControlPlaneForScope` is the only construction site (SC-03/08)      |
| held actions     | parallel approval queue + restart-broken executors            | serializable params + `registerExecutor`; decisions are `held_effect` steering in the shared approval store, settled by the bridge into the journal (SC-04) |
| taint/egress     | `assertEgressAllowed` few callers, no declassify              | `evaluateProvenanceEgress` single rule; egress guard on every `effect:egress` op; `requestDeclassify` hash-bound artifact grants (SC-06)                    |

## Invariants (fail-closed in CI)

`libs/core/scope/scope-governance-invariants.test.ts` + `check_op_effect_coverage`:

1. `mintScopeEnvelope` runs only at dispatch boundaries.
2. `tenantSlug` lives only on declared scope-identity record fields.
3. Preflight stage order is fixed (100 → 130).
4. `new CloudflareOsControlPlane(` exists only in `cloudflare-os-shared.ts`.
5. Every manifest capability declares `effect`.
6. Approval decisions — mission verbs and held effects alike — travel the
   shared `decideApprovalRequest` choke point.

## Links

- [entity-scope-hierarchy](./entity-scope-hierarchy.md) — the identity chain
- [multi-tenant-operations](./multi-tenant-operations.md) — tenant scope rules
- [runtime-storage-layout](./runtime-storage-layout.md) — journal floors
- Plan: `docs/developer/improvement-plans-2026-10/SCOPE_GOVERNANCE_UNIFICATION_PLAN_2026-10-03.ja.md`
- Mission: `MSN-SCOPE-GOV-UNIFY-20261003` (PR #896)
