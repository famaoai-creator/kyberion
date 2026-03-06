---
title: Sovereign Approval Protocol: Push & Passkey (2026-03-04)
category: Architecture
tags: [architecture, passkey, push, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Sovereign Approval Protocol: Push & Passkey (2026-03-04)

## 1. Executive Summary
エージェントの自律的な実行能力と、主権者の身体的意志（パスキー）を、Push通知をトリガーとして物理的に同期させる非同期承認プロトコル。

## 2. System Components
- **Orchestrator (CLI)**: 高リスク作業を検知し、`ApprovalRequest` を生成。
- **Notification Relay**: クラウド経由で主権者のデバイスへ実用的な要約（MSN-ID, Cost）を送信。
- **Sovereign Signer (PWA)**: 通知を受け取り、WebAuthn (Passkeys) による身体的署名を実行。
- **Physical Bridge**: `presence/bridge/approvals/` を介したファイルベースの最終合意同期。

## 3. Data Flow & Security
1. **Request**: CLI -> `pending/*.json` (Full data).
2. **Push**: Notification Relay -> Sovereign Device (Summary only).
3. **Validate**: Device reads `pending/*.json` (via Secure Sync) and matches with Push summary.
4. **Sign**: Sovereign authenticates via Biometrics -> Generates Passkey Assertion.
5. **Close**: Device writes `signed/*.signed.json` -> CLI verifies and executes.

## 4. Security Principles
- **End-to-End Integrity**: 通知要約と物理ファイルのリクエストハッシュが一致しなければ署名を拒否する。
- **Zero-Trust Relay**: リレーサーバーは署名鍵を持たず、通知の送達のみを責務とする。
- **Biometric Enforcement**: すべての高リスク作業（Risk Level >= 7）には、主権者の身体的介在を物理的に要求する。

## 5. Implementation Roadmap
- **Phase 1**: プロトコルおよび ADF スキーマの確定。 [DONE]
- **Phase 2**: Firebase Cloud Messaging (FCM) 等を用いたリレーサーバーの構築。
- **Phase 3**: WebAuthn 対応の PWA「Sovereign Signer」のプロトタイプ作成。
- **Phase 4**: `libs/core/secure-io` への署名検証レイヤーの実装。
