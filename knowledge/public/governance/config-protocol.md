---
title: Config Protocol: The Sovereign Rule of System State
category: Governance
tags: [governance, config, protocol]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Config Protocol: The Sovereign Rule of System State

このドキュメントは、Gemini Skills エコシステムの構成（Configuration）に関する基本原則を定義します。全てのミッションおよびエージェントはこのプロトコルを遵守しなければなりません。

## 1. 構成項目の物理的配置 (Source of Truth)

| 項目 | パス | ティア | 役割 |
| :--- | :--- | :--- | :--- |
| **Identity** | `knowledge/personal/my-identity.json` | Personal | ユーザーの氏名、言語、対話スタイル |
| **Session** | `active/shared/governance/session.json` | Personal | 現在アクティブなロール、スキルセット |
| **Connections** | `knowledge/personal/connections/*.json` | Personal | 各種外部サービス（Slack, Google 等）の認証情報 |
| **Secrets** | `knowledge/confidential/*.json` | Confidential | 組織・クライアント共有の秘匿情報 |

## 2. 変更の原則 (The Pillars of Change)

### Rule 1: 不揮発な証跡 (Immutable Audit)
構成を変更する全ての操作は、必ず `ledger.record('CONFIG_CHANGE', ...)` を呼び出し、レジャー（`governance-ledger.jsonl`）にハッシュチェーンの一部として記録しなければならない。

### Rule 2: 意図の明示 (Intent Explicit)
構成変更は、必ず単発の「ミッション（Mission）」内で行われ、そのミッションの `TASK_BOARD.md` に変更の「理由（Why）」が記載されていなければならない。

### Rule 3: ティアの厳守 (Tier Isolation)
API キーやトークンなどの秘匿情報は、決して `active/projects/` や Public ティアに配置してはならない。必ず `personal` または `confidential` に隔離すること。

### Rule 4: べき等性の担保 (Idempotency)
設定の「追加」だけでなく「更新」においても、既存の設定を破壊せず、可能な限り以前の状態をバックアップ（`.bak`）として残すこと。

## 3. リエントリ・プロトコル (Re-entry Protocol)

設定を変更したい場合、以前のミッションを再開する必要はない。新しいミッションを立ち上げ、このプロトコルを参照することで、いつでも最新の状態から安全に構成を更新することができる。
