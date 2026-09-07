---
title: Agent Collaboration View
category: Architecture
tags: [architecture, terminal-hud, collaboration, observability, surface, agent-dispatch]
importance: 7
author: Ecosystem Architect
last_updated: 2026-09-06
---

# Agent Collaboration View

## 1. 目的

「各エージェントが連携して動く様を把握する」ための、ターミナル主体の kyberion 利用者向け入口。ミッション → タスク → エージェント → 子エージェントがどう連携し、誰が誰を待っているかを一目で見せる。`pnpm tui`(terminal-hud)のパネル 9「連携」と、Chronos の `AgentCollaborationBoard` が同じデータ源・同じ合成関数から描画する。

設計の背景と決定事項の全体は計画書を参照: [`AGENT_COLLABORATION_VIEW_PLAN_2026-09-06.ja.md`](../../../docs/developer/improvement-plans-2026-08/AGENT_COLLABORATION_VIEW_PLAN_2026-09-06.ja.md)(AC-01〜07)。

## 2. データフロー

```
emitters                     on-disk sources                         projection                          tree                          surfaces
─────────                    ───────────────                         ──────────                          ────                          ────────
agent-dispatch.ts        →   active/shared/logs/worker-events/    →  agent-collaboration-projection.ts →  agent-collaboration-tree.ts →  terminal-hud パネル 9
 subagent_begin/end/          worker-events-YYYY-MM-DD.jsonl          buildAgentCollaborationProjection    composeCollaborationTree      Chronos AgentCollaborationBoard
 unavailable                                                          → nodes / edges / overview /
 (delegation_id,                                                        attention
 parent_agent_id, agent_id)
a2a-bridge.ts             →   active/shared/observability/
 a2a_message_routed             mission-control/
 (sender/receiver)              {task,orchestration,agent-runtime,
 approval_request/response      agent-runtime-supervisor}-events.jsonl
 work-coordination
```

- **emitters**: `libs/core/agent-dispatch.ts` の `HarnessSubagentDispatcher` / `ProcessSpawnDispatcher` が `subagent_begin/end/unavailable` を、`libs/core/a2a-bridge.ts` が `a2a_message_routed`(sender/receiver/performative/intent)・`approval_request/response`・work-coordination イベントを emit する。すべて `libs/core/worker-event-stream.ts` の単一 envelope(`type, ts, seq, source{mission_id,task_id,agent_id,...}, payload`)。
- **on-disk sources**: worker-event は `active/shared/logs/worker-events/worker-events-YYYY-MM-DD.jsonl`(日次)、mission-control 系は `observability/mission-control/{task,orchestration,agent-runtime,agent-runtime-supervisor}-events.jsonl`。
- **投影**: `libs/core/agent-collaboration-projection.ts` の `buildAgentCollaborationProjection` がこれらを読み、`nodes / edges / overview / attention` に合成する。既定は有界読み(`bounded` オプション。既定 `{ maxBytesPerFile: 2MiB, recentDays: 2, includeStepEvents: false }`)。`bounded: false` で従来の全読みに戻せる。`status_flags` に `bounded_read` が付くことで「切り詰めた」ことが利用者から見える。
- **木**: `libs/core/agent-collaboration-tree.ts` の `composeCollaborationTree(projection, opts?)` が I/O なしの純関数として、`mission → task → agent → child agent` の木と各ノードの `waiting_on`(`CollaborationWaitReason`: `approval_pending | child_running | claim_pending | blocked | review_pending | stale`)、`handoffs`(a2a `→ receiver` 注記)を導出する。並びは決定的(mission id → task id → started_at)。
- **surface**: terminal-hud パネル 9「連携」が木を前順走査でインデント表示し、上部に「いま待っているもの」を要約する。Chronos `AgentCollaborationBoard` は既存の統計・注意項目に加えて同じ木を折りたたみ section で描画する(additive)。

`buildAgentCollaborationProjection` の呼び出し元は terminal-hud、Chronos `api/collaboration` route、`headless-projections.ts`、`scripts/vital_check.ts` の 4 箇所。いずれも既定の有界読みで動く。

## 3. G1〜G4 ギャップとその解消

2026-09-06 の read-only 監査で見つかった 4 つの欠落と、本計画での解消内容:

| #   | ギャップ                                                                                                                    | 解消(AC 番号)                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 委譲イベントに相関鍵がない(`subagent_begin`/`end` を紐付ける ID も親エージェントも記録されていなかった)                     | `subagent_begin/end/unavailable` に `delegation_id`(begin で採番し end/unavailable まで不変)、`parent_agent_id`、`agent_id`、`team_role`、`provider`、`instruction_summary`(`redactCollaborationSummary` 経由の先頭 120 文字)、`elapsed_ms`(end のみ)を付与(AC-01)                                                                                                                                          |
| G2  | agent→agent エッジが redaction で disk に残らない(`a2a-bridge.ts` は emit するが `SHARED_METADATA_KEYS` 未収載のため消える) | `SHARED_METADATA_KEYS` に `sender / receiver / performative / intent / delegation_id / instruction_summary / elapsed_ms` を追加し、投影に `agent:sender → agent:receiver`(kind `handoff`)・`agent:parent → agent:child`(kind `spawn`)エッジを追加。孤児データだった `agent-runtime-events.jsonl`(キー `event`)も読み込み対象に加え、`event-vocabulary.ts` の `INFERENCE_RULES` で `MISSION_*` を分類(AC-02) |
| G3  | 投影の読み込みが無制限(29MB/26.6 万行の supervisor ファイル等を毎回全読み)                                                  | `ComposeCollaborationProjectionOptions.bounded` で既定を有界化。ファイル末尾から byte 上限で読み、日付付きファイルは `recentDays` で選別。`status_flags` に `bounded_read` を追加(AC-03)                                                                                                                                                                                                                    |
| G4  | HUD の表示が薄い(パネル 5 は attention 5 行 + overview 1 行のみ、木も drill-down もない。Chronos board も統計とリストのみ)  | I/O なしの `composeCollaborationTree` を新設し(AC-04)、terminal-hud パネル 9「連携」(AC-05)と Chronos `AgentCollaborationBoard` のツリー section(AC-06)が同じ関数から木 + 待ち関係 + drill-down を描画する                                                                                                                                                                                                  |

## 4. 運用ルール: kyberion dispatch を経由した作業だけが見える

このビューが可視化できるのは **kyberion の dispatch 経路(ミッション、work item、`delegateTask`)を通った作業だけ**である。`HarnessSubagentDispatcher` を直すことで `claude-agent` / `codex` 等のネイティブ委譲もこの経路に乗るが、Claude Code の Agent ツールが kyberion を経由せずに直接起こしたサブエージェント呼び出しは worker-event stream に何も残さないため、このツリーには一切現れない。これは可視化の欠陥ではなく運用上の制約であり、対処は「ミッション経由で流す」こと(本計画のスコープ外)。

## 5. 既知の限界・フォローアップ

- **secure-io に range read がない**: byte 上限は「全量読み込み後に末尾を切る」実装であり、parse 量は有界でも disk read 自体は全量。真の tail read(`createJsonlTail` の活用強化)は別 follow-up。
- **投影の日本語ハードコード**: `attention` の title/next_action と `agent-activity-board.ts` の blocker 文言は日本語の固定文字列で、HUD の `L` ロケール切替に追従しない。additive に `reason_code`(閉じた列挙)を足して surface 側が翻訳できるようにしたが、既存の日本語フィールド自体の撤去は別起票。
- **supervisor イベントファイルのローテーション未対応**: `agent-runtime-supervisor-events.jsonl` が無制限に肥大化する根本原因(ローテーション欠如)は本計画では触っていない。有界読みで表示影響は緩和したのみ。
- **peer-conversations は投影のエッジ源になっていない**: `observability/peer-conversations/**/events.jsonl` は依然として未消費。terminal-hud パネル 9 の detail(Enter)で `listPeerConversationSessions` 経由の transcript 末尾を読むに留まり、木のエッジには反映されない。

## 関連ドキュメント

- 計画書: [`docs/developer/improvement-plans-2026-08/AGENT_COLLABORATION_VIEW_PLAN_2026-09-06.ja.md`](../../../docs/developer/improvement-plans-2026-08/AGENT_COLLABORATION_VIEW_PLAN_2026-09-06.ja.md)
- [`agent-mission-control-model.md`](./agent-mission-control-model.md) — ミッション/エージェント/ランタイム所有の全体モデル
- [`multi-provider-coexecution-contract.md`](../governance/multi-provider-coexecution-contract.md) — 複数プロバイダ CLI の並行実行契約
- [`docs/SURFACES.md`](../../../docs/SURFACES.md) — サーフェス一覧(`pnpm tui` パネル 9 の位置づけ)
