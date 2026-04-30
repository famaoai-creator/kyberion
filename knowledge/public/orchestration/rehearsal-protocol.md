---
title: Rehearsal Mode Protocol
category: Orchestration
tags: [orchestration, rehearsal, negotiation, roleplay, agent-actuator]
importance: 7
author: Ecosystem Architect
last_updated: 2026-04-17
---

# Rehearsal Mode Protocol

本番の対人交渉 / 発表 / 面談の前に、相手役ペルソナを自動生成して **15 分のロールプレイ** を行うプロトコル。想定外反論を 1 周しておくことが目的。

## 1. 入力

- `counterparty_ref` — relationship-graph のノード
- `session_objective` — 本番で達成したい結果
- `time_budget_minutes` — 既定 15 分、最大 30 分

## 2. 相手役ペルソナ生成

agent-actuator の `a2a` を利用し、以下の合成 context で worker agent を召喚:

```
あなたは {person_slug} を演じる。以下の情報を優先順に参照し、
本人の口調・論理・警戒点を忠実に再現すること。決して主権者に迎合しない。

- 直近 interactions (history の最新 5 件)
- communication_style の honne/tatemae 傾向
- known_interests (公的 + 推定私的)
- outstanding_asks
- ng_topics (ここに触れたら相手は硬化する)
```

## 3. ロールプレイ実行

- 主権者と worker agent が **voice-actuator** 経由で会話する (or テキスト)。
- 15 分タイマー。
- 主権者が詰まる / 言い澱む箇所を `pause_map` として記録。

## 4. 事後レビュー (Debrief)

ロールプレイ終了後、`wisdom-actuator` が以下を自動生成:

- **Surprise list**: 主権者が想定していなかった反論 3〜5 件
- **Weak points**: 回答に 4 秒以上かかった質問
- **Recommended preps**: 本番前に準備すべき具体アクション

出力先: `active/missions/{MissionID}/evidence/rehearsal-debrief.md`

## 5. 安全原則

- ロールプレイで得た相手役の発言を **実在の本人の発言として記録しない** (relationship-graph への書き込み禁止)。
- 本プロトコルの成果物は `rehearsal-debrief.md` のみ。
- 本番が終わったら `rehearsal-debrief.md` は `archive/` に移動する (誤参照防止)。

## 6. 主な用途

- 投資家面談、顧客提案、ベンダー交渉、採用面接
- 悪い知らせ (リストラ通告、解約連絡) の伝達練習
- 取締役会での議案説明

## 7. 関連

- 依存: [relationship-graph-protocol.md](knowledge/public/orchestration/relationship-graph-protocol.md)
- 上位: [negotiation-protocol.md](knowledge/public/orchestration/negotiation-protocol.md)
- 実行: agent-actuator `a2a` + voice-actuator
- パイプライン: [pipelines/negotiation-rehearsal.json](pipelines/negotiation-rehearsal.json)

---
_Created: 2026-04-17 | Ecosystem Architect_
