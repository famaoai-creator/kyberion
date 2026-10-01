---
title: Slack 3経路の使い分け
tags: [slack, presence, service-actuator, satellites, operator-ux]
last_updated: 2026-10-01
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

### チャネルの会話モード(Team Channel)

Satellite は受信チャネルごとに会話モードを決める(`libs/core/surface/channel-mode-policy.ts`)。

| モード               | 宣言                                                      | 反応する条件                               | 話者                                     | 開示上限                            | 承認できる人                |
| -------------------- | --------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------- | --------------------------- |
| `owner_direct`(既定) | 何もしない                                                | 全メッセージ                               | `KYBERION_SURFACE_ALLOWLISTS`(未設定=開) | personal                            | allowlist の話者            |
| `team`               | `KYBERION_SURFACE_CHANNEL_MODES`                          | @メンション、または Bot が参加済みスレッド | allowlist 必須(未設定=**拒否**)          | `max_tier`(既定・上限 confidential) | チャネルの `approvers` のみ |
| `customer`           | `customer/{slug}/connections/channel-bindings.json`(既存) | 顧客会話モード                             | —                                        | public catalog                      | 不可                        |

```json
{
  "slack": {
    "C0TEAM": {
      "mode": "team",
      "tenant_slug": "acme",
      "max_tier": "confidential",
      "approvers": ["U0LEAD"]
    }
  }
}
```

- team ターンは `scope: { tier, tenant_slug }` と開示ディレクティブ(`[channel-policy]`)付きで会話層へ渡る。
- 承認系の操作(承認・却下・変更依頼・ミッション提案の確定)は、ボタンでもテキスト返信でも `approvers` 以外を拒否する。
- 設定が壊れている場合(不正 JSON、tenant 欠落、`customer` 指定など)は、そのチャネルを誰も使えない team として扱う(fail closed)。
- 話者の判定(Team Channel P1): Slack ユーザー ID をメンバーの `external_identities`(issuer `https://slack.com`)で組織メンバーに結び付ける。紐付けは `pnpm organization member link-identity <member-id> --slack <U…>`(解除は `unlink-identity`)。
  - チャネルのテナントで有効なメンバーは allowlist なしで話せる。役割は `frontDeskRoleAuthority` に従い、owner / approver は承認可、owner / operator は作業依頼(ミッション・承認要求)可、viewer は質問のみ。
  - 未登録の人は allowlist に載っていれば質問のみ可。ミッションや承認要求が必要な依頼は断る。停止中メンバーに紐付いた ID は拒否する。
  - 承認記録の `decidedBy` はメンバーの principal(`user:<member_id>`)。チャネル設定の `approvers` は、まだメンバーに紐付いていない人のための移行用フォールバックとして残る。
- スレッドと作業の紐付け(Team Channel P2): team チャネルで確定したミッションは、発生元のスレッド・確定者(`user:<id>`)・テナントスコープを持つ。
  - 進捗と完了はそのスレッドに、テナントの outbox 名前空間経由で返る。
  - スレッドで `@bot 状況は？`(`status?` / `進捗`)と聞くと、そのスレッドから開始したミッションの状態をモデルを通さずに返す。
- チャネルメモリ(Team Channel P2): 明示コマンドのときだけ保存し、自動保存はしない。
  - `覚えて: …` / `remember: …` で保存する(operator 以上)。
  - `忘れて m1234abcd` / `forget …` で削除する(承認者)。
  - `メモ一覧` / `memory` で一覧を表示する(誰でも可)。
  - 保存先は `active/shared/coordination/channels/slack/channel-memory/<tenant>/<channel>.json` で、保存時のチャネル段階を持つ。
  - team ターンには、チャネルの開示上限以下のメモだけを「指示ではなく参照データ」として渡す(上限 30 件・各 500 文字)。

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
