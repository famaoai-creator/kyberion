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

## 1.1 Kyberion との連携（成果物・レビュー・ミッション）

議論は「話して終わり」にせず、人間のレビューを経て仕事につなげる。

```
decision ─► publishDiscussionOutcomes                       (discussion-outcomes.ts)
              ├─ minutes.md      … 機械可読な議事録（差分・ナレッジ化の元）
              ├─ brief.html      … 意思決定ブリーフ（人が読む・レビューする）  (discussion-brief.ts)
              │                     どちらも ArtifactRecord（tier 付き）として登録 → Deliverables inbox
              └─ next_steps → WorkItem 候補（outcomes_proposed）        ← 自動では作らない
                                │
     人間が「意思決定ブリーフ」をレビュー（sandbox iframe、postMessage で結果だけ返す）
                                │   POST /api/discussions/<id>/review              (discussion-review.ts)
        ┌───────────────────────┼───────────────────────────┐
     承認して進める            差し戻す                       却下
     ・編集を反映               ・コメントを議論に差し込み       ・記録のみ
     ・採用分を WorkItem 化      ・部屋が追加ラウンドで再開       ・WorkItem は作らない
     ・（任意）ミッション開始の   ・新しい決定 → 再レビュー
       承認依頼を積む
                │
     承認キューで人間が承認 ─► 「ミッションを開始」 ─► mission_controller start   (discussion-mission.ts)
                                 └ 部屋・WorkItem・成果物に mission_id を書き戻す
```

- **意思決定ブリーフ**は外部リソースを一切読まない自己完結の HTML。合意度の推移（SVG）、ラウンドごとの立場マップ（セルから元の発言へジャンプ）、懸念と解消の経過、決定・合意・残った反対意見、次のアクション（`review` モードでは件名・優先度・担当の役割・採否を編集可）、発言の全文（発言者で絞り込み）を含む。`view`（保存される成果物）は読み取り専用、`review`（`?mode=review`）は `localadmin` のときだけ編集と決定のコントロールが出る。
- **安全性**: 配信時の CSP は `sandbox allow-scripts` + `default-src 'none'`、iframe に `allow-same-origin` は付けない。ブリーフは資格情報を持たず、編集と決定を `postMessage` でホスト（Chronos）へ返すだけで、ホストは `event.source` が自分の iframe であることを確認してから viewer として API を呼ぶ。本文はすべてエスケープして埋め込む。
- **人間ゲートは二段**: ①ブリーフのレビュー（承認・差し戻し・却下）、②ミッション開始の承認依頼（既存の承認キュー）。決定が WorkItem になるのも、ミッションが始まるのも、必ず人間の操作を経る。
- **ミッション開始は mission_controller の専有**: 承認依頼も `mission_controller` の権限で書き、開始は承認済み（人間が decide 済み）のときだけ `issueChronosMissionFromProposal` 経由で行う。未承認・二重開始は拒否。環境が未 onboarding なら mission_controller が拒否し、その旨を画面に返す。
- **ミッション連携**: 部屋の作成時に `mission_id` を指定すると、viewer が見えるミッションに限り紐づく（tenant / project / tier を引き継ぐ）。
- **双方向の導線**: WorkItem の行から「この件を議論する」（`/?section=discussion&goal=…&mission=…`）、議論由来の WorkItem から「元の議論を開く」。
- **ロスター**: 発言エンジンが LLM のとき、目的に必要な追加席を LLM が提案する。未知の役割は捨て、人数は上限で丸める。結果は `roster_source`（`llm` / `rules`）として残り、UI に表示される。
- **UI の置き場所**: Chronos の「判断」グループ（承認・議論・ナレッジ）に統合。`/discussion` の単独ページも残す。

## 2. 可視性と認可

- 発言の全文を表示する。**見える範囲は認証・認可レイヤ（ViewerContext）が決める**。
- 部屋は作成時に viewer の `tenant_slug`（必要なら `organization_id` / `project_id`）を刻印する。一覧・取得・SSE・コマンドはすべて `lib/discussion-access.ts` でスコープ判定する。tenant を持たない部屋は tenant 限定 viewer には見せない（deny-unless-scoped）。
- クライアントの `tenant` パラメータは viewer の許可集合を狭めるだけで、広げられない。
- 読み取りは `readonly`、部屋の作成とコマンドは `localadmin`。

## 3. 拡張ポイント

- 新しい議論プロトコル（ACE のロールペルソナ採点など）は `DiscussionSpeaker` の実装または `DiscussionEngine` のフェーズとして追加する。
- ロスターは発言エンジンが LLM のときだけ LLM 提案、それ以外は目的のキーワード規則。TC-12 の roster proposer と `mission-team-plan-composer`（ミッションのチーム計画・staffing 台帳）への統合は未接続（`docs/developer/improvement-plans-2026-09/TEAM_COMPOSITION_DYNAMICS_PLAN_2026-09-20.ja.md`）。
- 議事録のミッション証跡化（`record-evidence`）は未接続。ミッションを始めたあとの進行は通常のミッション運用に委ねる。

## 4. 関連

- [Agent Communication and Coordination Model](./agent-communication-layer-model.md)
- [Agent Collaboration View](./agent-collaboration-view.md)
- [mission-team-composition-model](./mission-team-composition-model.md)
