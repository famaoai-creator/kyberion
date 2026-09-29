---
title: Discussion Room — facilitated multi-agent discussion
category: Architecture
tags:
  [architecture, chronos, surface, multi-agent, facilitator, team-composition, agent-communication]
importance: 7
author: Ecosystem Architect
last_updated: 2026-09-29
---

# Discussion Room

目的に向けて、組織のエージェント群から組成したチームが、ファシリテーターのもとで会話しながら結論へ進む仕組み。人間はコマンドセンターから議論に介入できる。

## 1. 構成

```
goal ──► composeDiscussionTeam        (libs/core/discussion/discussion-team.ts)
            team-roles + agent-profiles を capability 一致 / preferred_agents / 職務分離で選定
         │
         ▼
      DiscussionEngine                 (discussion-engine.ts) — 部屋ごとに単一オーナー
         framing → exploring (rounds) → converging → decision
         各ターン境界で human command を取り込む
         │  speak / summarize / conclude
         ▼
      DiscussionSpeaker                (discussion-speaker.ts)
         ReasoningDiscussionSpeaker : registered reasoning backend (delegateTask)
         ScriptedDiscussionSpeaker  : 決定論的・オフライン（デモ / テスト）
         │
         ▼
      events.jsonl (event-sourced)     active/shared/runtime/discussions/<id>/events.jsonl
         │  reduceDiscussionRoom       (discussion-reducer.ts)
         ▼
      Chronos  /api/discussions[/<id>[/stream|/command]]  →  /discussion (3 panes)
```

- **真実の源は `events.jsonl` のみ**。UI が描く状態は `reduceDiscussionRoom` の純関数投影で、サーバー再起動後も同じ状態に戻る。
- 人間の介入は `command` イベントとして追記され、エンジンが `command_ack` で確定する（`pause` / `resume` / `inject` / `ask` / `redirect` / `open_vote` / `cast_vote` / `set_speaker` / `conclude` / `stop`）。
- 合意度は各参加者の直近 stance（support / neutral / question / oppose）から算出する。閾値到達かつ未解消論点なしで収束、上限（`max_rounds` / `max_messages`）でも決定を出す。

## 2. 可視性と認可

- 発言の全文を表示する。**見える範囲は認証・認可レイヤ（ViewerContext）が決める**。
- 部屋は作成時に viewer の `tenant_slug`（必要なら `organization_id` / `project_id`）を刻印する。一覧・取得・SSE・コマンドはすべて `lib/discussion-access.ts` でスコープ判定する。tenant を持たない部屋は tenant 限定 viewer には見せない（deny-unless-scoped）。
- クライアントの `tenant` パラメータは viewer の許可集合を狭めるだけで、広げられない。
- 読み取りは `readonly`、部屋の作成とコマンドは `localadmin`。

## 3. 拡張ポイント

- 新しい議論プロトコル（ACE のロールペルソナ採点など）は `DiscussionSpeaker` の実装または `DiscussionEngine` のフェーズとして追加する。
- ロスターは現状 deterministic。TC-12 の LLM ロスター提案と `mission-team-plan-composer` への統合は未接続（`docs/developer/improvement-plans-2026-09/TEAM_COMPOSITION_DYNAMICS_PLAN_2026-09-20.ja.md`）。
- 部屋を mission / WorkItem に紐づけるには `scope.mission_id` を使う（現状は未配線）。

## 4. 関連

- [Agent Communication and Coordination Model](./agent-communication-layer-model.md)
- [Agent Collaboration View](./agent-collaboration-view.md)
- [mission-team-composition-model](./mission-team-composition-model.md)
