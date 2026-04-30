---
title: Negotiation Mission Protocol
category: Orchestration
tags: [orchestration, negotiation, mission, batna, zopa]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-17
---

# Negotiation Mission Protocol

対人交渉を「ミッション」として扱うための必須構造。既存の `standards/contract/negotiation_guardrails.md` (契約技法) の上位に位置する **戦略層** を定義する。

## 1. Mission Sub-type

- `type: "negotiation"` として mission-state.json に明示する。
- development / evaluation とは異なり、**成果物はコードではなく合意** である。

## 2. 必須フィールド (Planning Phase)

mission-state.json 内に `negotiation` ブロックを追加し、以下を **合意前に** 埋めることを必須とする:

```json
{
  "negotiation": {
    "counterparty_ref": "knowledge/confidential/relationships/{org}/{person}.json",
    "objective": "string (合意したい結果)",
    "our_batna": "string (合意不成立時の次善策)",
    "their_batna_estimate": "string (相手側の次善策の推定)",
    "zopa": {
      "floor": "string",
      "ceiling": "string",
      "confidence": "low | medium | high"
    },
    "concession_ladder": [
      { "step": 1, "give": "string", "get": "string" },
      { "step": 2, "give": "string", "get": "string" }
    ],
    "information_asymmetry": {
      "they_know_we_dont": ["string"],
      "we_know_they_dont": ["string"]
    },
    "red_lines": ["string (絶対に譲らない条件)"]
  }
}
```

詳細: [schemas/negotiation-state.schema.json](schemas/negotiation-state.schema.json)

## 3. フェーズ

| Phase | 目的 | 使うプロトコル |
|---|---|---|
| P1. Preparation | 上記フィールドを全て埋める。相手情報は relationship-graph から引く。 | [relationship-graph-protocol.md](knowledge/public/orchestration/relationship-graph-protocol.md) |
| P2. Rehearsal | 相手役ペルソナとロールプレイ。想定外反論を 1 周する。 | [rehearsal-protocol.md](knowledge/public/orchestration/rehearsal-protocol.md) |
| P3. Nemawashi (任意) | 正式交渉前の個別擦り合わせ。 | [stakeholder-consensus-protocol.md](knowledge/public/orchestration/stakeholder-consensus-protocol.md) |
| P4. Session | 実際の交渉。coaching surface が並走。 | [real-time-coaching-protocol.md](knowledge/public/orchestration/real-time-coaching-protocol.md) |
| P5. Debrief | 結果を relationship-graph に反映。譲った項目と理由を dissent-log に保存。 | relationship-graph-protocol.md + dissent-log |

## 4. 自律性の境界

- P1, P2, P3, P5: エージェント主導で可 (主権者の確認を挟む)。
- **P4 (本番交渉) は必ず人間が主導する**。エージェントは補助輪 (hint 提供) のみ。

## 5. 成果物

- `evidence/negotiation-outcome.json` — 合意内容、譲歩履歴、残課題
- `evidence/batna-post-mortem.md` — BATNA 推定が正しかったかの事後検証
- relationship-graph の更新

## 6. 関連

- 契約技法: [standards/contract/negotiation_guardrails.md](knowledge/public/standards/contract/negotiation_guardrails.md)
- ステークホルダー管理: [pmo/standard/stakeholder_management.md](knowledge/public/pmo/standard/stakeholder_management.md)
- 人格: `Strategic Deal-Maker` ([personalities/matrix.md](knowledge/public/personalities/matrix.md#8))

---
_Created: 2026-04-17 | Ecosystem Architect_
