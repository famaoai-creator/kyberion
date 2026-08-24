---
title: Kybweion Services / kyberion プロダクトリリース運用改善計画
tags: [tenant, project, mission, release-governance, kybweion-services]
last_updated: 2026-08-12
status: active
---

# Kybweion Services / kyberion プロダクトリリース運用改善計画

## 目的

`Kybweion Services` を tenant、`kyberion のプロダクトリリース` を project の正本として、
リリース、検証、運用改善を同じ context chain で追跡できる状態にする。

正規の関係は次のとおりとする。

```text
Kybweion Services (tenant: kybweion-services)
  └─ kyberion のプロダクトリリース (project: PRJ-KYBWEION-PRODUCT-RELEASE)
       └─ release / governance mission
            └─ task / task_session
```

これは project が mission の親になるという意味ではなく、project は durable context、mission は
governed ownership、task は bounded work item として責務を分離する。

## 棚卸しで確認した不足

| ID    | 不足                                                                                            | 対応                                                                        | 状態                                     |
| ----- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| PR-01 | project 作成後に project OS と `04_control` ledger を後から安全に用意する CLI がなかった        | `pnpm project scaffold <PROJECT_ID>` を追加                                 | DONE                                     |
| PR-02 | release governance 用の mission がなく、tenant/project/mission の追跡開始点がない               | tenant/project に bind した governance mission を作成                       | DONE                                     |
| PR-05 | release slice を project に安全に持続化する facade がなかった                                   | `pnpm project track create/update` と tenant-aware reconcile を追加         | DONE                                     |
| PR-03 | 既存 mission の多くが project context を持たず、active mission を一括移動すると所有権を壊し得る | 既存 mission を分類し、scope が一致する paused/planned のみ再割当候補にする | PARTIAL（scope 一致候補なし）            |
| PR-04 | tenant registry に既存の fixture/customer directory drift が残っている                          | logs-only fixture を documented exception にし、今回の tenant と混同しない  | DONE（stale exception warning は別整理） |

## 実装済みの初期状態

- tenant: `kybweion-services` / 表示名 `Kybweion Services` / tier `confidential`
- project: `PRJ-KYBWEION-PRODUCT-RELEASE` / 表示名 `kyberion のプロダクトリリース`
- project OS: `active/projects/confidential/kybweion-services/PRJ-KYBWEION-PRODUCT-RELEASE/project-os`
- ledger: `project-os/04_control/mission-ledger.md` と JSON ledger
- governance mission: `MSN-KYBWEION-PRODUCT-RELEASE-20260812`
- mission relationship: `governs`、traceability ref は本計画
- release track: `TRK-KYBWEION-PRODUCT-RELEASE` / `continuous_delivery` / `KYBERION-RELEASE-20260812`

## 既存 mission の整理方針

1. `archive` は completed/failed のみ governed archive で処理する。今回の棚卸しでは対象なし。
2. `active` mission は作業中の所有権を持つため、自動 cancel、pause、archive、reassign をしない。
3. release に明確に関係する mission は、目的・tenant・tier・成果物を確認した上で候補化する。
4. `paused` または `planned` の mission を再割当する場合も、対象 project の ledger と tenant 境界を確認してから `mission reassign-project` を使う。
5. 再割当、cancel、archive、外部 repository への publish は operator 承認を必要とする。

### 2026-08-12 時点の整理結果

既存 8 mission はいずれも今回の release project には移動していない。新規の governance
mission だけが project relationship と release track を持つ。stale な active mission 2件は、
残タスクを保持したまま `pause` した。

| 状態   | tier         | mission                                   | 現時点の扱い                                         |
| ------ | ------------ | ----------------------------------------- | ---------------------------------------------------- |
| paused | confidential | `GE-ORCHESTRATION-2026-07`                | stale 整理で pause。再開または cancel は別判断       |
| active | confidential | `MSN-ONBOARDING-CONTEXT-20260811`         | onboarding 作業として現状維持                        |
| paused | confidential | `MSN-REALTIME-VOICE-REVIEW-20260720`      | stale 整理で pause。再開または cancel は別判断       |
| paused | public       | `DS-06-CHRONOS-LIGHT-THEME`               | public→confidential の scope mismatch のため現状維持 |
| paused | public       | `MSN-AGENT-COLLAB-OBSERVABILITY-20260726` | public→confidential の scope mismatch のため現状維持 |
| active | public       | `MSN-EXEC-SURFACE-20260811`               | 既存 owner の確認待ち。scope mismatch のため現状維持 |
| active | public       | `MSN-MAINTENANCE-RECORD-TASK`             | maintenance として現状維持                           |
| active | public       | `MSN-WG-PORT-20260811`                    | 既存 owner の確認待ち。scope mismatch のため現状維持 |

mission の tenant/project bind を推測して変更するのは行わない。public mission を
confidential tenant に入れる操作は、facade が tier/tenant mismatch として拒否する。

## 次の実装ウェーブ

### Wave 1: context の可視化

- `project show PRJ-KYBWEION-PRODUCT-RELEASE --json` で project、track、mission、task_session、operational state を確認する。
- mission status と project ledger の対応を定期的に照合する。
- `hygiene` と `archive` の dry-run を定期実行し、stale / abandoned / archive 候補を分離する。

### Wave 2: release track の導入

- release 用 track を project facade から作成できるようにした。
- track は `release` 型とし、mission の `track_id`、lifecycle model、traceability を必須にする。
- track 作成・mission 再割当は operator の明示承認を境界にする。track と operational state は
  tenant scope を保ったまま同時に reconcile する。

### Wave 3: mission 整理の安全な一括提案

- 既存 mission の tenant、tier、status、project relationship、最終 checkpoint、残 task を JSON で出力する。
- 自動適用ではなく、候補ごとに理由、影響、必要な承認を含む manifest を生成する。
- apply は hash-bound manifest と operator approval を要求する。

## 完了条件

- 新しい release work が `tenant_slug → project_id → mission_id → task_id` の context chain を持つ。
- project ledger と mission state の双方で同じ mission が確認できる。
- active mission を暗黙に別 project へ移さない。
- tenant registry check の既存 drift と今回の tenant を区別して報告できる。
- logs-only fixture は削除せず documented exception として監査可能にする。
- project scaffold、mission link、dry-run archive の検証結果が計画に追記される。

## 検証コマンド

```sh
pnpm tenant list --json
pnpm project show PRJ-KYBWEION-PRODUCT-RELEASE --json
pnpm project reconcile PRJ-KYBWEION-PRODUCT-RELEASE --dry-run --json
MISSION_ROLE=mission_controller KYBERION_PERSONA=sovereign node dist/scripts/mission_controller.js hygiene --stale-days 2 --abandoned-days 14
MISSION_ROLE=mission_controller KYBERION_PERSONA=sovereign node dist/scripts/mission_controller.js archive
```
