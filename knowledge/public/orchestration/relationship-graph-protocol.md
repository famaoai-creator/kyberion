---
title: Relationship Graph Protocol
category: Orchestration
tags: [orchestration, relationship, stakeholder, memory, negotiation]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-17
---

# Relationship Graph Protocol

人 (stakeholder) を単位とする構造化メモリ層の定義。対人交渉・稟議・nemawashi の前段で必ず参照され、面談ごとに更新される。

## 1. 配置場所

```
knowledge/confidential/relationships/
  └── {org_slug}/
      └── {person_slug}.json   ← relationship-node.schema.json 準拠
```

- **confidential tier** に配置する (3-tier isolation)。personal / public への leak は禁止。
- `org_slug` の例: `nbs`, `ss`, `dt`, `external-{counterparty}`。

## 2. ノード構造 (要約)

- **identity**: name, role, org, contact (optional)
- **trust_level**: 1-5 (主権者主観)、更新履歴付き
- **communication_style**: honne/tatemae 傾向、好む媒体、嫌う話題
- **known_interests**: 公的関心事と推定される私的関心事 (separately)
- **history**: 直近 N 件の interaction summary (max 20 件ローリング)
- **outstanding_asks**: 本人から出ているが未解決の要望
- **ng_topics**: 地雷リスト (e.g. 過去の失敗、個人情報)

詳細: [schemas/relationship-node.schema.json](schemas/relationship-node.schema.json)

## 3. 更新プロトコル

### 3.1 自動更新
- **`presence-actuator`** が会議終了を検知したタイミングで、音声ログと画面共有から以下を抽出し、ノードに追記:
  - 面談概要 (3 文)
  - 相手が言及した懸念 / 要望
  - トーンの変化 (怒気 / 同意 / 留保)
- **`voice-actuator`** が 1on1 中のキーワードと沈黙パターンから「今日は触れない方が良い話題」を暫定タグ付け。

### 3.2 手動更新
- 主権者が `memory:update-relationship {person_slug}` で直接編集可能。
- 自動更新と手動更新の衝突時は **手動を優先** し、自動側は `pending_suggestions` に退避。

### 3.3 減衰 (Decay)
- `history` は 90 日経過で自動的に summarize され、`long_term_summary` に圧縮される。
- `trust_level` は半年更新がない場合に UI 上で「要再確認」表示。

## 4. 利用先

- [negotiation-protocol.md](knowledge/public/orchestration/negotiation-protocol.md) — BATNA 推定と stakeholder map 生成
- [stakeholder-consensus-protocol.md](knowledge/public/orchestration/stakeholder-consensus-protocol.md) — 根回し順序の最適化
- [rehearsal-protocol.md](knowledge/public/orchestration/rehearsal-protocol.md) — 相手役ペルソナ生成

## 5. セキュリティ

- 全ファイルは `secure-io` 経由でのみ read/write 可。
- ログへの本文出力禁止。ID と hash のみ許可。
- 外部 API への relationship 情報送信は、approval-actuator の dual-key policy 下でのみ。

---
_Created: 2026-04-17 | Ecosystem Architect_
