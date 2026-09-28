---
title: エージェントインスタンスプール — 同一モデル複数 NHI によるスケールアウト
last_updated: 2026-09-28
tags: [workforce, NHI, agent-pool, capacity, TC]
---

# Agent Instance Pool Plan

## 背景と問題

`collectWorkforceLoad` は work-item ストアから actor 単位の負荷を集計し、
`active_work_items >= 1` で `busy` と判定する。これは「1 エージェント = 1
アイデンティティ = 直列実行」モデルとしては正しいが、同時に**同一モデルの
処理能力を増やす手段がエージェント数を増やす以外にない** — LLM の直列
制約（ローカル CLI/セッション型 ≒ 1 並列）とコンテキストカプセル化
（タスク毎に独立したコンテキストパック）を前提とすると、actor 内並列は
設計上あり得ない。

議論の結果、同一 identity で並列実行する（`busy` 閾値の再設計）よりも、
**同一モデルに複数の NHI を宣言する**方が一貫性が高い:

- work-item 単位の責務帰属・lease・SoD 意味論を一切崩さない
- `busy`/capacity 機構を変更せず既存の分散スコアで自動的に負荷分散される
- 監査上も「別 identity」は定義通りの職務分離

## 設計

### agent profile に `instance_count` を宣言する

`knowledge/product/orchestration/agent-profiles/<id>.json`（または集約された
`agent-profile-index.json`）の record に optional `instance_count: 1..8` を
追加する。`N > 1` のとき index 読み込み時に合成インスタンスを展開する:

```
planner-agent (instance_count: 3)
  → planner-agent     (instance_index: 1, instance_of: 'planner-agent')
  → planner-agent-2   (instance_index: 2, instance_of: 'planner-agent')
  → planner-agent-3   (instance_index: 3, instance_of: 'planner-agent')
```

- base id はそのまま有効（既存参照を壊さない）
- インスタンスは全フィールド（capabilities / team_roles / provider/model
  hints / authority_roles）を共有し、`instance_of`/`instance_index` のみ
  追加する
- NHI 帰属は instance id が担う（work-item assignee/lease/audit にそのまま
  載る）

### 選定への影響

`selectAgentForTeamRole` は agents index を走査してスコアリングするため、
展開されたインスタンスは**自動的に別候補**として評価される。busy な
インスタンスには loadPenalty がかかり、空きインスタンスが自然に選ばれる
— busy 判定の閾値・意味を変える必要がない。

### 運用の上限

`instance_count` の最大は 8（schema で enforce）。それ以上のスケールは
worker プールの管理問題（restaff や provider quota）に入るため別議論。

## 残る論点

- **SoD の実質性**: 別 NHI でも同一モデルなら「職務分離」は名目上のものに
  なりうる。現行は provider/model 単位までしか見ていないため、大きな悪化
  ではないが、separation ルールを「別モデル必須」に絞る運用もあり得る
- **runtime 制約**: identity を増やしても CLI 型（対話セッション）は
  spawn 層で直列のまま — parallel な runtime（API/stateless 型）でこそ
  意味を持つ。インスタンス増は spawn 側の同時起動数と同時に検討すべき
- **カタログ管理**: NHI 数増大は catalog 管理コストになる。sync 式や
  generated 機構への展開が将来課題

## 実装範囲

1. `AgentProfileRecord` に `instance_count?`/`instance_of?`/`instance_index?`
   を追加
2. `agent-profile-index.schema.json` に `instance_count` (integer 1-8) を
   追加
3. `loadAgentProfileDirectory`/`loadAgentProfileSnapshot` でインスタンス
   展開（`expandAgentProfileInstances` 共有関数）
4. `MissionTeamAssignment` の監査フィールドに `instance_of` を引き継ぐ
5. テスト: index 展開 + 負荷分散選定
