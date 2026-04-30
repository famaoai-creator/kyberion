---
title: Real-time Coaching Surface Protocol
category: Orchestration
tags: [orchestration, coaching, presence, voice, realtime]
importance: 7
author: Ecosystem Architect
last_updated: 2026-04-17
---

# Real-time Coaching Surface Protocol

会議・交渉の **最中に** 、音声トーン・沈黙・強調語からシグナルを抽出し、操作者の画面端に hint を差し込むプロトコル。**応答の自動化は行わない**。補助輪 (copilot) に徹する。

## 1. コンセプト

- エージェントは「もう一人の自分」として、操作者の視界の隅で **小さく警告 / 示唆** を出す。
- 判断と発話は常に人間が行う。エージェントは判断しない。

## 2. 入力シグナル

`voice-actuator` と `presence-actuator` が以下をリアルタイム抽出:

| シグナル | 閾値 | 意味 (推定) |
|---|---|---|
| 相手の沈黙 | 3 秒以上 | 同意でない / 思考中 / 不満 |
| 相手の早口化 | 発話速度 +30% | 焦り / 隠蔽 / 関心低下 |
| 相手の強調語 | 「絶対」「必ず」「しかし」 | 立場の固定化 |
| 主権者の詰まり | 3 秒以上の言い澱み | 準備不足の兆候 |
| トピック回避 | ng_topic 検知 | 話題を外す必要あり |

## 3. Hint 出力

Presence Studio / Chronos Mirror の側面パネルに、以下のような短い hint を表示する:

```
[12:34:52] 沈黙 4 秒。同意ではない可能性。確認質問を検討。
[12:35:18] 相手の早口化。論点を 1 つに絞って再提示を。
[12:36:02] ng_topic "前回の失注" に接近。迂回推奨。
```

- hint は 1 行、最大 40 文字。
- 1 分間に最大 3 件まで (操作者の注意を奪いすぎない)。
- 音声通知は **無効** がデフォルト。視覚のみ。

## 4. 非目標 (Non-Goals)

- **自動応答はしない** (ChatBot 化しない)。
- **感情推定を断言しない** ("相手は怒っています" ではなく "沈黙 4 秒")。
- **録音の永続化はしない** (終了時に音声データは破棄、抽出サマリのみ保持)。

## 5. 起動条件

- `mission-state.json` に `coaching: { enabled: true }` が明示されている
- 主権者が事前に相手に録音同意を取得済み (手動チェック)
- `approval-actuator` で「会議コーチングモード有効」を dual-key 承認

## 6. 成果物 (会議終了後)

- `evidence/coaching-session.md` — hint 履歴 + 操作者の反応 (採否)
- relationship-graph への自動更新候補 (pending_suggestions)

## 7. 関連

- 実行: voice-actuator + presence-actuator
- 表示: Presence Studio, Chronos Mirror
- 依存: [relationship-graph-protocol.md](knowledge/public/orchestration/relationship-graph-protocol.md)
- 倫理: [governance/governance-policy.md](knowledge/public/governance/governance-policy.md)

---
_Created: 2026-04-17 | Ecosystem Architect_
