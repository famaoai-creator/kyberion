---
title: Tenant / Organization / Onboarding / Autonomous Operations 統合計画
tags: [tenant, organization, onboarding, scope, memory, nhi, autonomy, governance]
last_updated: 2026-08-15
status: completed
---

# Tenant / Organization / Onboarding / Autonomous Operations 統合計画

## 目的

tenant、organization、customer stance、NHI、スコープ別 memory、オンボーディング、
自律運用を、同じ `ScopeContext` と activation lifecycle で接続する。

正準 containment は次の一つだけとする。

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
```

`customer/{slug}` は stance overlay であり、tenant registry の代替でも、scope chain の
一階層でもない。tenant registry は stance に依存せず、customer 側には検証可能な
binding/facet だけを置く。

## 実装方針

### Wave 0 — 正準 scope 契約

- [x] `ScopeContext` を追加し、tenant / organization / project / mission / task / tier /
      stance / viewer / NHI を統一する。
- [x] `tenant_id` は既存境界の互換入力として扱い、内部正本を `tenant_slug` に寄せる。
- [x] confidential scope の tenant 欠落、親 scope 不一致、reserved scope 名を fail-closed
      にする（activated runtime は `KYBERION_TENANT_SCOPE_REQUIRED=true` で強制し、legacy fixture は段階移行する）。
- [x] tenant registry の正本解決を `KYBERION_CUSTOMER` から独立させる。
- [x] `allow_cross_distillation` の既定値を false とし、brokered promotion のみを許可する。

### Wave 1 — tenant activation と onboarding

- [x] tenant lifecycle を `draft → validating → ready → active → suspended → offboarding → archived`
      に拡張する。
- [x] activation は registry、organization binding、viewer scope、NHI、service readiness、
      memory policy、isolation probe、accountable human の確認と、各 probe の監査証跡 ref を
      全て満たす場合だけ許可する。receipt は tenant / organization / tier ごとに保存する。
- [x] dry-run / apply / resume / rollback / reconcile を idempotent にする。
- [x] onboarding summary と activation receipt に stance、tenant、organization、tier、NHI、
      memory policy、service readiness、次の行動を表示する。

### Wave 2 — scope 別 memory

- [x] session/task、mission、project、organization、tenant、personal、public の memory 層を
      scope envelope 付きで保存する。
- [x] memory item と promotion candidate に scope chain、tier、owner NHI、provenance、retention、
      audience、promotion policy、redaction 状態を持たせる。
- [x] retrieval は tier、同一 tenant、許可された audience、owner NHI、ancestor/public の条件を
      全て満たすものだけを返し、未知・欠落 scope は tenant データを返さない。
- [x] tenant → public の昇格は source tenant、redaction、承認者、監査証跡を必須にする。

### Wave 3 — NHI と自律運用

- [x] NHI affiliation に tenant を明示し、発行時に organization parent を検証する。
- [x] 実行権限は task-scoped grant、tenant suspend/offboarding は grant/NHI の停止・retire
      と連動する。
- [x] tenant queue、lease、heartbeat、quota、budget、approval gate、pause/escalation、drift
      watcher を activation 後の運用契約にする。
- [x] 主要な activation、memory、NHI、grant、mission-context、API projection に ScopeContext／tenant
      boundary を付与し、未解決 scope は activated runtime で表示・実行を拒否する。

## 受け入れ条件

1. stance を切り替えても tenant registry の正本が変わらない。
2. 未登録、suspended、archived tenant は confidential の読み書きと activation を拒否する。
3. customer / tenant / organization の不一致は書き込み前に拒否される。
4. tenant 無しの confidential memory、projection、NHI grant は作成・返却されない。personal
   memory も owner または明示 audience がない限り返却されない。
5. memory promotion は evidence、source scope、redaction、承認を検証できる。
6. onboarding の途中失敗を resume または rollback でき、再実行で重複しない。
7. tenant offboarding で tenant memory、runtime residue、NHI、grant、projection が監査付きで
   retire される。
8. Acme / Beta / unknown tenant の分離テストが、storage・memory・API projection・NHI の全てで
   green になる。

## 実装状況

- 2026-08-15: 本計画を追加。既存の tenant registry checker が top-level customer stance
  directory を tenant として扱わない方針を前提に、ScopeContext、activation、memory、NHI、
  autonomous operation の統合実装を完了。legacy fixture は `KYBERION_TENANT_SCOPE_REQUIRED=true`
  による段階導入とし、activated runtime は fail-closed 契約を使用する。
