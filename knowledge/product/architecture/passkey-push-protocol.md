---
title: 'Sovereign Approval Protocol: Push & Passkey (2026-03-04)'
category: Architecture
tags: [architecture, passkey, push, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-10-10
kind: evergreen
---

# Sovereign Approval Protocol: Push & Passkey (2026-03-04)

## 1. Executive Summary

エージェントの自律的な実行能力と、主権者の身体的意志（パスキー）を、Push通知をトリガーとして物理的に同期させる非同期承認プロトコル。

## 2. System Components

- **Orchestrator (CLI)**: 高リスク作業を検知し、`ApprovalRequest` を生成。
- **Notification Relay**: クラウド経由で主権者のデバイスへ実用的な要約（MSN-ID, Cost）を送信。
- **Sovereign Signer (PWA)**: 通知を受け取り、WebAuthn (Passkeys) による身体的署名を実行。
- **Approval Runtime Buffer**: `active/shared/approvals/` を介したファイルベースの最終合意同期。

## 3. Data Flow & Security

1. **Request**: CLI -> `pending/*.json` (Full data).
2. **Push**: Notification Relay -> Sovereign Device (Summary only).
3. **Validate**: Device reads `pending/*.json` (via Secure Sync) and matches with Push summary.
4. **Sign**: Sovereign authenticates via Biometrics -> Generates Passkey Assertion.
5. **Close**: Device writes `signed/*.signed.json` under the governed approval buffer -> CLI verifies and executes.

## 4. Security Principles

- **End-to-End Integrity**: 通知要約と物理ファイルのリクエストハッシュが一致しなければ署名を拒否する。
- **Zero-Trust Relay**: リレーサーバーは署名鍵を持たず、通知の送達のみを責務とする。
- **Biometric Enforcement**: すべての高リスク作業（Risk Level >= 7）には、主権者の身体的介在を物理的に要求する。

## 5. Implementation Roadmap

- **Phase 1**: プロトコルおよび ADF スキーマの確定。 [DONE]
- **Phase 2**: 通知リレー。Web Push（Concierge の「この端末に通知する」）で実装済み。 [DONE]
- **Phase 3**: WebAuthn による署名。Concierge を Sovereign Signer とし、A3 の承認カードをパスキーで決める（HA-07）。 [DONE]
- **Phase 4**: 署名検証レイヤー。`libs/core/authn/webauthn-verifier.ts` と approval store のチャレンジ消費で実装（HA-07）。 [DONE]
- **未実装**: CLI 起点の Push から PWA で署名して CLI に戻す往復（現状は Concierge の承認キューで決める）。

## 6. Implementation (HA-07, 2026-10-10)

上記 §3 のファイル受け渡し（`pending/` → `signed/`）は採らず、共有 approval store を正本にした。

1. **Request**: どの起点でも approval store に依頼を作る。human_only の依頼は `min_assurance` を持つ
   （dual-key secret・policy 変更・project trust は A3）。
2. **Push**: Web Push は「何かが待っている」ことだけを伝える（内容は載せない）。
3. **Validate**: Concierge が依頼を描画し、presented digest を計算する。
4. **Sign**: `POST /api/approvals/{id}/passkey` の `options` が、依頼 id・決定・presented digest・期限・nonce を
   束ねたチャレンジ（`sha256` の base64url、単回、120 秒、依頼の期限より後にはならない）を発行し、
   approval store の `passkey-challenges/` に保存する。ブラウザが `@simplewebauthn/browser` で署名する。
5. **Close**: `verify` が rpID / origin（governed な公開 origin）、チャレンジ、期限、未使用、資格情報の持ち主、
   署名カウンタの前進（後退は拒否）を検証する。approval store は検証済みチャレンジを消費し、digest が
   一致したときだけ `authMethod: 'passkey'`（A3）で記録する。

資格情報（公開鍵・カウンタ・transports・ラベル）は `knowledge/personal/members/{id}/passkeys.json` に保存し、
Concierge の 設定 › プロフィール › パスキー で登録・削除する。詳細は
[approval-gate-design](../governance/approval-gate-design.md) の「認証強度（assurance）とパスキー」。
