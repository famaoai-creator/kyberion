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

## 1.1 Kyberion との連携（成果物・WorkItem・ミッション）

議論は「話して終わり」にせず、決定を仕事につなげる。

```
decision ─► publishDiscussionOutcomes            (discussion-outcomes.ts)
              ├─ minutes.md を生成 → ArtifactRecord(kind=markdown, tier) として登録
              │     → Chronos の Deliverables inbox に、部屋の tenant / organization / project / mission 付きで出る
              └─ next_steps → WorkItem 候補（outcomes_proposed）        ← 自動では作らない
                    │  人間が選択して承認（POST /api/discussions/<id>/outcomes）
                    ▼
              createWorkItemsFromDecision → WorkItem(backlog)
                    context = tenant → organization → project → mission（work_shape=solution_project）
                    labels  = discussion, discussion:<id> / metadata = discussion_id, proposal_id, minutes_artifact_id
```

- **人間ゲート**: 決定から WorkItem への変換は必ず人間の操作を挟む（`localadmin`）。同じ提案の二重登録は冪等に無視する。
- **ミッション連携**: 部屋の作成時に `mission_id` を指定すると、viewer が見えるミッションに限り紐づく。ミッションの tenant / project / tier を部屋が引き継ぎ、成果物と WorkItem の context chain に載る。ミッションの状態そのものは変更しない（開始・checkpoint・finish は mission_controller の専有）。
- **双方向の導線**: WorkItem の行から「この件を議論する」（`/?section=discussion&goal=…&mission=…`）、議論由来の WorkItem から「元の議論を開く」。
- **ロスター**: 発言エンジンが LLM のとき、目的に必要な追加席（`researcher` 等の固定席以外）を LLM が提案する。未知の役割は捨て、人数は上限で丸めるので、提案が壊れていても組成は失敗しない。結果は `roster_source`（`llm` / `rules`）として部屋に残り、UI に表示される。
- **UI の置き場所**: Chronos の「判断」グループ（承認・議論・ナレッジ）に統合。`/discussion` の単独ページも残す。

## 2. 可視性と認可

- 発言の全文を表示する。**見える範囲は認証・認可レイヤ（ViewerContext）が決める**。
- 部屋は作成時に viewer の `tenant_slug`（必要なら `organization_id` / `project_id`）を刻印する。一覧・取得・SSE・コマンドはすべて `lib/discussion-access.ts` でスコープ判定する。tenant を持たない部屋は tenant 限定 viewer には見せない（deny-unless-scoped）。
- クライアントの `tenant` パラメータは viewer の許可集合を狭めるだけで、広げられない。
- 読み取りは `readonly`、部屋の作成とコマンドは `localadmin`。

## 3. 拡張ポイント

- 新しい議論プロトコル（ACE のロールペルソナ採点など）は `DiscussionSpeaker` の実装または `DiscussionEngine` のフェーズとして追加する。
- ロスターは発言エンジンが LLM のときだけ LLM 提案、それ以外は目的のキーワード規則。TC-12 の roster proposer と `mission-team-plan-composer`（ミッションのチーム計画・staffing 台帳）への統合は未接続（`docs/developer/improvement-plans-2026-09/TEAM_COMPOSITION_DYNAMICS_PLAN_2026-09-20.ja.md`）。
- 議事録のミッション証跡化（`record-evidence`）と、決定に基づく mission_controller 経由のミッション開始は未接続。現状は成果物として登録するところまで。

## 4. 関連

- [Agent Communication and Coordination Model](./agent-communication-layer-model.md)
- [Agent Collaboration View](./agent-collaboration-view.md)
- [mission-team-composition-model](./mission-team-composition-model.md)
