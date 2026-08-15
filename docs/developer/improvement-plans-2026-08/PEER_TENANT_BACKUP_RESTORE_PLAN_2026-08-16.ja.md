---
title: Kyberion peer / Mesh Hub tenant 境界と backup / restore 統合計画
tags: [tenant, peer, mesh-hub, message, backup, restore, quarantine]
last_updated: 2026-08-16
status: in_progress
---

# Kyberion peer / Mesh Hub tenant 境界と backup / restore 統合計画

## 目的

同一 tenant の Kyberion peer 間連携を、transport、conversation、Mesh Hub、runtime
storage、backup / restore で同じ tenant 境界として扱う。peer message を backup 本体の
転送経路にはせず、暗号化 artifact の参照と承認状態を運ぶ control plane として利用する。

## 現状確認

- Mesh Hub の typed request は `tenant_scope.scope=same_tenant` と tenant slug を検証する。
- peer catalog は `knowledge/confidential/{tenant}/connections/peer-network.json` に保存される。
- しかし通常の `PeerMessageEnvelope`、conversation session、inbox / outbox、Mesh Hub の
  registration / presence / delivery は peer ID または共有 JSONL 単位で、transport と
  物理 storage の tenant binding が不足している。
- `backup --scope all` は `active/` 全体を含むが、`backup --scope tenant` は peer runtime
  を含まない。restore 後の presence、lease、outbox をそのまま再開する契約もない。

## 設計判断

### 1. tenant binding は envelope と receiver の双方で必須にする

`tenant_id` を HMAC 署名対象の envelope に含める。sender の catalog 選択だけに依存せず、
receiver server の configured tenant、peer registration の tenant、envelope tenant の三者を
一致させる。不一致、tenant 欠落、reserved scope 名は fail-closed とする。

### 2. runtime は tenant を第一級の物理 namespace にする

次の形を正本とする。

```text
active/shared/runtime/peer-messaging/tenants/{tenant}/peers/{peer}/...
active/shared/observability/peer-messaging/tenants/{tenant}/peers/{peer}/...
active/shared/runtime/peer-conversations/tenants/{tenant}/peers/{peer}/...
active/shared/observability/peer-conversations/tenants/{tenant}/peers/{peer}/...
active/shared/runtime/mesh-hub/{namespace}/tenants/{tenant}/...
active/shared/observability/mesh-hub/{namespace}/tenants/{tenant}/...
```

共有 JSONL を export 時に tenant ごとに再構成する方式は、append-only lineage と partial
restore の整合性が弱くなるため採用しない。legacy root は移行 script で tenant namespace
へ移し、移行不能な record は quarantine する。

### 3. backup / restore は data plane ではなく control plane と分離する

- local owner が encrypted tenant backup を作成する。
- artifact store / external reference に置き、`artifact_ref`、`integrity_hash`、tenant、
  backup scope、expiration の metadata だけを same-tenant message で通知する。
- receiver は明示的に accept した後、local restore を実行する。
- restore は `--scope tenant --tenant <slug>` を要求し、peer runtime は quarantine 状態で
  復元する。fresh heartbeat、key / endpoint 再検証、operator approval 後に再開する。
- raw archive の peer message payload 化、remote からの直接 mission mutation、automatic
  restore は許可しない。

## 実装フェーズ

### Wave 1: tenant-bound transport

- [x] envelope / signature / server に tenant binding を追加
- [x] conversation session / message に tenant を追加
- [x] peer conversation server と Mesh adapter の local tenant check を統一
- [x] tenant mismatch / missing tenant / cross-tenant catalog の regression test

### Wave 2: physical namespace と backup

- [x] peer messaging / conversation / Mesh Hub runtime を tenant namespace 化
- [x] tenant backup allowlist に runtime と observability を追加
- [x] legacy record migration と quarantine report を追加（`pnpm migrate:peer-tenant-runtime`。tenant を推定できない record は source ごと quarantine）
- [x] tenant backup round-trip test を追加

### Wave 3: restore quarantine と通知

- [x] restore 後の presence / claim / outbox / proposal の quarantine policy を実装
- [x] re-enrollment / heartbeat / operator approval の resume gate を実装（`pnpm peer:runtime-recovery request|resume`）
- [x] encrypted backup artifact reference の notification contract を追加
- [x] restore drill と two-peer tenant E2E を実行

## 受け入れ条件

1. tenant の異なる envelope は、正しい HMAC でも receiver が拒否する。
2. tenant runtime の JSONL を別 tenant の export が読み取れない。
3. tenant backup に peer messaging、conversation、Mesh Hub の tenant runtime が含まれ、
   別 tenant の record が含まれない。
4. restore 後に stale presence / delivery lease が自動実行されない。
5. artifact reference 通知だけで raw backup bytes が peer message / Mesh journal に入らない。
6. 同じ idempotency key の restore / delivery retry で duplicate work が生成されない。

## 非目標

- v1 Mesh Hub を public federation service にすること
- peer message から直接 backup、mission、外部 side effect を実行すること
- cross-tenant delivery を `same_tenant` contract に紛れ込ませること

## 実装状況

- 2026-08-16: 現行 peer / Mesh / backup の tenant 境界と restore 連携を調査し、本計画を追加。
- 2026-08-16: backup 側では tenant registry、physical runtime namespace、manifest restore
  validation、quota、explicit restore target を実装済み。
- 2026-08-16: peer envelope / conversation / Mesh Hub directory・adapter・delivery ledger を
  tenant namespace 化し、tenant backup allowlist、restore quarantine、backup artifact reference
  notification contract と regression / E2E を実装。旧 flat record の split 移行と source
  quarantine、human approval・再 enrollment・fresh heartbeat を要求する resume gate まで完了。
