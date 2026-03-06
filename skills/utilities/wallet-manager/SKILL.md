---
name: wallet-manager
description: Gatekeeper for agent economic autonomy and external MFA approvals.
status: planned
category: Utilities
last_updated: '2026-03-04'
tags: gemini-skill
---

# Wallet Manager (Draft)

エージェントの経済的自律性と、主権者による外部承認（External MFA）を仲介するゲートキーパー。

## 📋 Role & Responsibility

- **Request Generation**: リスクレベルと金額に基づき `ApprovalRequest` (ADF) を生成し、`presence/bridge/approvals/pending/` へ出力する。
- **Approval Monitoring**: 外部デバイスからの署名済みトークン（`SignedProof`）を `presence/bridge/approvals/signed/` で監視する。
- **Transaction Execution**: 有効な署名トークンを伴う場合のみ、API決済や高リスク作業を実行する。
- **Quota Enforcement**: 主権者によって設定された予算（Quota）を L4/L3 領域で厳格に管理する。

## 🛠 Planned Interface

```typescript
// Approval Request
interface ApprovalRequest {
  request_id: string;
  intent: string;
  risk_level: number;
  amount_usd?: number;
  expires_in: number; // seconds
}

// Signed Proof
interface SignedProof {
  request_id: string;
  signature: string; // JWS or similar
  sovereign_pubkey: string;
  timestamp: string;
}
```

## 🧠 Governance Rule

1. **No Signature, No Action**: 有効な署名トークンがない高リスク作業（Level >= 7）は、物理的にブロックされる。
2. **One-Time Token**: 承認トークンは1回限り（Nonce）または有効期限（TTL）を持つ。
3. **Audit Evidence**: すべての承認と拒否は `presence/bridge/approvals/logs/` に永続化され、監査証跡となる。
