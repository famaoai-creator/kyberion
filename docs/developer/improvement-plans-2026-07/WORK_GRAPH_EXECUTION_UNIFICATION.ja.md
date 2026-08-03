---
title: Work Graph and Execution Surface Unification
tags: [work-graph, work-item, agent-runtime, subagent, handoff, next-tasks]
last_updated: 2026-08-02
role_affinity: [orchestrator, planner, mission_controller, implementer]
phase_affinity: [alignment, execution, review]
---

# Work Graph と実行面の統合計画

## 背景

現在のKyberionでは、`agent-runtime`、CLIサブエージェント、actuator、WorkItem、`NEXT_TASKS.json` が別々の境界を持っています。特に `delegateTask` の一部はWorkItemを作成せずに実行されるため、claim、lease、handoff、attempt、監査の連鎖が切れる可能性があります。

## 目標

Missionから実行結果までを、同じ `work_item_id` と `attempt_id` で追跡できるようにします。

```text
Mission
  -> Canonical Work Graph
  -> WorkItem / dependency edge / handoff packet
  -> ExecutionPort (CLI subagent | agent-runtime | actuator)
  -> attempt / result / evidence / audit
```

`NEXT_TASKS.json` は正規状態ではなく、既存CLI・画面との互換projectionに降格します。

## 原則

1. Work Coordinationが作業所有権（claim・lease・handoff・attempt）を持つ。
2. agent-runtimeはruntimeの生存性・provider・sessionを持つが、作業状態は持たない。
3. transport/A2Aはメッセージ配送であり、作業所有権を直接変更しない。
4. CLIサブエージェント、agent-runtime、actuatorは同じExecutionPort契約を使う。
5. `NEXT_TASKS.json` への直接編集は禁止し、projectionの再生成で更新する。

## 実装フェーズ

### Phase 1: 共通実行境界（今回）

- `CoordinatedAgentExecutionPort` を追加する。
- 実行前にWorkItemをclaimし、実行後にattempt/result/statusを保存する。
- `work_item_id`、`mission_id`、`attempt_id`、`runtime_id` をreceiptへ残す。
- agent-runtime supervisorを利用する既存 `AgentExecutionPort` を内部Adapterとして再利用する。
- 成功・失敗の両方でWorkItemのleaseを閉じる。

### Phase 2: Work Graph投影

- `NEXT_TASKS.json` からWorkItemへの一方向importを明示する。
- WorkItemの依存関係をcanonical graphとして検証する。
- WorkItemから `NEXT_TASKS.json` を再生成するprojectionを追加する。
- graph handoffに `work_item_id` と `attempt_id` を含める。

### Phase 3: Mission handoff統合

- mission-level handoffを未完了WorkItemへ展開する。
- 旧leaseを解放し、handoff packetを保存して新担当へclaimさせる。
- `handoff_written` / `handoff_consumed` を発火する。
- target runtimeが未起動ならsupervisorへensureを依頼する。

### Phase 4: 直接delegateTaskの収束

- `delegateTask` の直接呼び出しを、mission/work item contextがある場合は共通Portへ移行する。
- mission外の短命な分析・修復は、明示的に `ephemeral` として記録する。
- background review、A2A fanout、subagent retryを同じattemptモデルへ接続する。

### Phase 5: NEXT_TASKS依存の縮小

- dispatch、reconciliation、dashboardの読み取りをWork Graphへ移行する。
- `NEXT_TASKS.json` は互換projectionとしてのみ維持する。
- projection driftを検出する整合性チェックを追加する。

## 完了条件

- CLIサブエージェントとagent-runtimeの両方で、同じWorkItemにattempt/resultが残る。
- handoff後に旧leaseが残らず、新担当がpacketをconsumeできる。
- runtime再起動後もWorkItemとattemptから再開できる。
- `NEXT_TASKS.json` を削除してもcanonical Work Graphから再生成できる。
- graph、handoff、runtime、reviewのE2Eテストが通る。
