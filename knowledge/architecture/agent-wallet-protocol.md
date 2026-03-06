---
title: Agent Wallet & Passkey Approval Protocol (2026-03-04)
category: Architecture
tags: [architecture, agent, wallet, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Agent Wallet & Passkey Approval Protocol (2026-03-04)

## 1. Concept: The Sovereign Signer
エージェントの自律的な経済活動と、主権者の身体的認証（Passkeys）を物理的に統合する。

## 2. Separate Signer Architecture (SSA)
- **Private Key Isolation**: 秘密鍵は主権者の物理デバイス（Secure Enclave）に隔離され、CLI 環境には一切露出しない。
- **Passkey Integration**: FIDO2/WebAuthn 標準を採用し、Touch ID/Face ID を署名のトリガーとする。
- **Physical Bridge**: `presence/bridge/approvals/` を介した非同期通信。

## 3. Dynamic Guardrails (Reflex)
- **Risk-Based Authentication**: リスクレベルおよび金額に基づき、自動承認、CLI承認、パスキー承認を動的に切り替える。
- **Cryptographic Enforcement**: 有効な署名トークンがない限り、`wallet-manager` は API 決済を実行できず、`secure-io` は機密データを復号できない。

## 4. Future Roadmap
1. **Phase 1 (Spec)**: 本プロトコルによる ADF スキーマの確定。 [DONE]
2. **Phase 2 (Bridge)**: `presence/bridge/` を監視し、OS 標準のパスキーダイアログを呼び出す `passkey-bridge` デーモンの開発。
3. **Phase 3 (Wallet)**: 署名検証レイヤーを搭載した `wallet-manager` スキルの実装。
4. **Phase 4 (Sovereign App)**: 複数エージェントを統合管理するモバイル版 Sovereign Signer の開発。
