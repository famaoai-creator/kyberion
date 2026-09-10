---
title: Co-Session Coordination (Same-Checkout, Mission-Optional)
category: Architecture
tags: [architecture, co-session, multi-provider, coordination, peer-messaging, work-coordination]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-11
---

# Co-Session Coordination

同一リポジトリ checkout 上で、複数のプロバイダ CLI（`claude` / `cursor` / `codex` / `agy` / `grok` など）が
**mission 無しでも**協調するための薄いレイヤ。

## 1. 目的と非目的

### 目的

- 同じ cwd / repo root で並走する CLI が、共有ゴール・存在確認・書き込み排他・引き継ぎを共有できる。
- peer messaging / Mesh Hub / work-coordination と**語彙を揃え**、必要時に昇格できる。

### 非目的

- peer messaging の代替（対 Kyberion インスタンスの署名付き transport）ではない。
- mission lifecycle / `.git` 所有 / 顧客証跡の代替ではない。
- CLI ごとに peer listener を立てて「peer で協調したことにする」ことではない。

## 2. 層関係

```
[同一 checkout の CLI 群]
        │
        ▼
  co-session  (本ドキュメント)
  presence / path lease / blackboard / handoff
        │  他マシン・他 Kyberion が必要
        ▼
  peer messaging (+ Mesh Hub allowlisted kinds)
        │  git / 承認 / 顧客証跡が必要
        ▼
  mission + work-item claim + dispatch-workitems
```

| 層                | 単位                                  | 役割            |
| ----------------- | ------------------------------------- | --------------- |
| co-session        | 同一 checkout の参加者（provider id） | ローカル協調    |
| peer messaging    | Kyberion peer（HMAC・HTTP）           | transport       |
| work-coordination | WorkItem + item lease                 | 横断の作業実体  |
| mission           | mission owner + work-item claim       | 所有・証跡・git |

既存の整理（[`work-coordination-platform-plan.md`](../orchestration/work-coordination-platform-plan.md)）どおり:

> peer messaging は transport。協調にはその上の coordination layer が必要。

co-session はその coordination の **same-checkout 面**である。

## 3. 不変条件

[`multi-provider-coexecution-contract.md`](../governance/multi-provider-coexecution-contract.md) を継承する。

1. **読み取り**は全参加者並行可。
2. **書き込み**は path lease 保持者のみ（短 TTL、heartbeat 切れで解放可）。
3. **`.git` / repo config** は co-session では触らない。commit が要る場合は mission owner へ昇格。
4. **一時ファイル**は `active/shared/tmp/` または session 配下のみ。
5. **peer / Mesh の禁止を継承**: co-session → peer の bridge は mission を作らない・承認しない（Mesh ADR）。

## 4. データ配置

```
active/shared/runtime/co-sessions/
  CURRENT                     # sticky: いまの session_id（任意）
  {session_id}/
    session.json              # goal, status, created_at, checkout_root
    presence.jsonl            # heartbeat
    blackboard.md             # 共有メモ
    leases/{path_hash}.json   # path 単位リース
    handoffs.jsonl            # 依頼・完了通知
active/shared/observability/co-sessions/
  {session_id}/events.jsonl   # 監査イベント
```

## 5. 語彙（Mesh / work-coordination と揃える）

Handoff / 依頼の `kind` は Mesh Hub の allowlist と同系:

- `review.request`
- `workitem.claim`（path lease 取得の意図記録にも可）
- `workitem.handoff`
- `workitem.status_update`
- `notification.publish`

ローカル専用の方言を増やさない。他 peer へ lift するときは同じ kind を peer envelope / `mesh-request` に載せる。

## 6. CLI 面

`pnpm exec tsx scripts/co_session.ts`（`co-session` コマンド）:

| 動詞                           | 意味                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `start`                        | goal 付きで session 開始（sticky CURRENT 更新）                                                |
| `join`                         | 既存 / sticky session に参加 + heartbeat                                                       |
| `leave`                        | 参加終了、自 lease 解放                                                                        |
| `heartbeat`                    | presence 更新                                                                                  |
| `status`                       | 参加者・lease・未 ack handoff                                                                  |
| `blackboard`                   | 表示 / 追記                                                                                    |
| `lease acquire\|release\|list` | path 排他                                                                                      |
| `handoff create\|list\|ack`    | 引き継ぎ。同一プロバイダ複数時は `--to-participant-id` / `--participant-id` でインスタンス指定 |
| `promote-hint`                 | peer / mission 昇格の次コマンドを表示（実行はしない）                                          |

同一モデルが複数並走する場合、参加者は `provider` + `participant_id`（既定 `{provider}-{pid}`）で区別する。path lease と handoff の宛先・ack は participant 単位。`--to claude` のみはプロバイダ種へのブロードキャスト、`--to-participant-id claude-b` は特定インスタンス宛て。

## 7. 昇格ゲート

| 状況                   | 行く先                          |
| ---------------------- | ------------------------------- |
| 同じ checkout 内の分業 | co-session のみ                 |
| 別ホスト / 別 Kyberion | peer messaging + 明示 accept    |
| git・承認・顧客証跡    | mission（`mission_controller`） |

## 8. 実装マップ

- Core: `libs/core/co-session.ts`
- CLI: `scripts/co_session.ts`
- 契約参照: 本ファイル + multi-provider coexecution + work-coordination platform + peer-network

## 9. 関連

- [`multi-provider-coexecution-contract.md`](../governance/multi-provider-coexecution-contract.md)
- [`work-coordination-platform.md`](../orchestration/work-coordination-platform.md)
- [`peer-network.md`](../orchestration/peer-network.md)
- Mesh ADR: [`2026-06-24-mesh-hub-v1-boundaries.md`](./decisions/2026-06-24-mesh-hub-v1-boundaries.md)
