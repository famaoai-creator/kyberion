---
title: Slack 3経路の使い分け
tags: [slack, presence, service-actuator, satellites, operator-ux]
last_updated: 2026-09-06
---

# Slack 3経路 — 会話 / 通知 / API

Kyberion には Slack へ届く道が3つある。**同じ `chat.postMessage` に見えても、役割が違う。** 迷ったら下の図と表で選ぶ。

```text
                    人間の Slack ワークスペース
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   slack-bridge         presence-actuator    service-actuator
   (satellite)           dispatch            service:preset
   双方向の会話           一方的な配信         ガバナンス付き API
   承認スレッド           タイムライン/ログ     投稿・履歴の読み取り
```

## どれを使うか

| やりたいこと                                             | 使う経路           | 入口                                                                                                                 |
| -------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Slack で依頼を受け、スレッドで承認し、同じスレッドに返す | **Satellite**      | `satellites/slack-bridge` / surface runtime。[`docs/SURFACES.md`](./SURFACES.md) の会話チャネル                      |
| パイプラインの結果を「人に見せる」(会話ループは不要)     | **Presence**       | `presence:dispatch`。Slack binding が無いと **log-only** に落ちる                                                    |
| issue/digest を API で投稿する、または履歴を読む         | **Service preset** | `service:preset` `service_id: slack` / MCP `kyberion.service.capture`(履歴) / `kyberion.service.actuate`(投稿は承認) |

## 1. Satellite — 会話の入口

- 実装: `satellites/slack-bridge/src/index.ts`
- 流れ: Slack イベント → `runSurfaceMessageConversation` → エージェント → 同じチャネルへ返信
- 向き: **双方向**。深い履歴閲覧には不向き([`docs/SURFACES.md`](./SURFACES.md))
- 日常: 「Slack で Kyberion に話しかける」はこれ。アクチュエータの `dispatch` ではない

## 2. Presence — 人への配信ブリッジ

- 実装: `libs/actuators/presence-actuator`
- public ops: `dispatch`, `receive_event`, `dispatch_timeline`
- `dispatch` の**既定**外部バックエンドは Slack。binding が無ければログへフォールバック
- 向き: **一方的**。会話の状態機械は持たない
- **satellite 転送** (新アクチュエータは作らない): `channel` に prefix を付けると既存 surface outbox へ enqueue し、各 satellite が drain する
  - `telegram:<chatId>` → `satellites/telegram-bridge` (port 3035)
  - `discord:<channelId>` → `satellites/discord-bridge`
  - `imessage:<chatId>` → `satellites/imessage-bridge` (port 3034)
  - 未 prefix / `slack:<id>` → 従来の Slack WebClient
- 日常: ミッション完了通知、タイムライン。会話ループは各 satellite の役割のまま

## 3. Service preset — ガバナンス付き Slack API

- 実装: `knowledge/product/orchestration/service-presets/slack.json`
- 実行: pipeline `op: service:preset`、または助手向け `kyberion.service.capture`(read) / `kyberion.service.actuate`(write)
- 今ある ops:
  - `post_message` — 投稿(write、承認対象)
  - `conversations_history` / `conversations_replies` — 履歴(read)
  - `files_list` — ファイル一覧(read)
- 日常: digest 投稿、ingest 用の履歴取得。会話ループは持たない

## やってはいけないこと

- 同じ通知を satellite と preset の両方で送る(二重投稿)
- presence に Slack token が無い状態で「送ったつもり」になる(log-only)
- 履歴閲覧を satellite に期待する(深い履歴は preset の `conversations_history`)

## 関連

- 面の地図: [`docs/SURFACES.md`](./SURFACES.md)
- アクチュエータ一覧: [`CAPABILITIES_GUIDE.md`](../CAPABILITIES_GUIDE.md)
- 助手の読み取り面: MCP `kyberion.service.capture` / `kyberion.capability.list` / allowlist の `pipelines/daily-routine.json`
