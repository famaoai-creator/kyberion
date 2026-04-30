---
title: Stakeholder Consensus Protocol
category: Orchestration
tags: [orchestration, consensus, stakeholder, negotiation, pre-alignment]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-20
---

# Stakeholder Consensus Protocol

正式提案（board, ringi, team meeting 等）の **前** に、影響の大きいステークホルダーを個別に訪問し、反対の兆しを early に発見・吸収する汎用プロトコル。日本的な「根回し（nemawashi）」はこのプロトコルの 1 variant として扱う。

## 1. 目的

- 「正式場での初めての反対表明」を防ぎ、撤回コストを最小化する。
- 反対の理由（利害 / 面子 / 情報不足）を分類し、公式提案時の資料に織り込む。
- 最終的な合意可能性を **readiness matrix** として数値化する。

## 2. Variant（文化・組織別の実装）

汎用骨格（Power/Interest 順序 × 1on1 × dissent 吸収 × readiness 数値化）は不変。以下は配布経路と擦り合わせスタイルの違い。

| Variant | 典型的な文化圏 | 配布経路 | 擦り合わせの主形式 |
|---|---|---|---|
| `nemawashi` | 日本企業 | 非公式 1on1（廊下・会食） | honne/tatemae の聞き分け、口頭での確約 |
| `round_table` | 欧米企業 | 公式会議（事前レビュー付き） | 文書と議事での反論吸収 |
| `pre_read_memo` | Amazon 系 | 6-pager / 1-pager 事前配布 | silent reading → 論点別議論 |
| `bilateral_memo` | 外交・政府 | 2 者間文書往復 | 文言交渉、合意事項の逐次確定 |

- variant の選択は「組織の意思決定文化」と「提案の重量級」で決まる。
- 同一ミッションで複数 variant を混用してよい（例：役員には nemawashi、現場責任者には pre_read_memo）。

## 3. 入力

- `proposal_draft.md` — 通したい提案の素案
- `stakeholder_list` — 関与すべき `person_slug` 配列（relationship-graph 参照）
- `deadline` — 正式提案日
- `variant` — 上記のいずれか。省略時はミッションオーナーの文化設定値に従う。

## 4. 順序決定（全 variant 共通）

Power/Interest Grid に基づく：

1. **High Power / High Interest** → 最初に訪問（反対なら提案自体を再考）
2. **High Power / Low Interest** → 2 番目（満足させておく）
3. **Low Power / High Interest** → 3 番目（情報共有で味方化）
4. **Low Power / Low Interest** → 実施省略可

## 5. セッション構造

### 5.1 骨格（variant 共通）

1. **Context sharing** — 提案の背景と本人への影響
2. **Listening** — 懸念・反対・条件を引き出す（**話すより聞く比 3:7**）
3. **Soft ask** — 「正式提案の場で反対はされますか」だけ明示確認

### 5.2 variant 別の時間配分例

| Variant | Context | Listening | Soft ask | 備考 |
|---|---:|---:|---:|---|
| `nemawashi` | 3 分 | 10 分 | 2 分 | 会食・立ち話での短時間版 |
| `round_table` | 5 分 | 15 分 | 5 分 | 事前 1on1 としての公式版 |
| `pre_read_memo` | 0 分（文書配布） | 20 分 | 10 分 | silent reading + Q&A |
| `bilateral_memo` | 非同期 | 非同期 | 文書往復 | 時間ではなく反復回数 |

### 5.3 Dissent Signal Extraction

セッション後、`voice-actuator` / `protocol-to-markdown` 等が自動で以下を抽出：

- 明示的反対（explicit）
- 留保・沈黙・話題回避（implicit — variant `nemawashi` で頻出）
- 条件付き賛成（conditional）

日本語データの `communication_style` enum に `honne` / `tatemae` は残す。骨格は普遍、値（文化表現）は具体。

## 6. Feed-Forward

次の訪問・レビューに向かう前に、直前の反応で得た dissent signal を用いて：

- 提案文言の微調整（言い換え / 省略 / 追記）
- 次の訪問先への想定問答の更新

これを全ステークホルダーで繰り返す。

## 7. 出力: Readiness Matrix

```json
{
  "proposal_ref": "path",
  "deadline": "ISO",
  "variant": "nemawashi | round_table | pre_read_memo | bilateral_memo",
  "visits": [
    {
      "person_slug": "string",
      "visited_at": "ISO",
      "stance": "support | conditional | neutral | oppose",
      "conditions": ["string"],
      "dissent_signals": ["string"]
    }
  ],
  "readiness_score": "number (0-100)",
  "recommendation": "proceed | delay | redesign"
}
```

## 8. 倫理原則

- 本プロトコルは **情報操作** ではなく **情報整理** である。
- 反対意見を意図的に隠蔽する目的で使ってはならない。
- 反対が多数派になった場合は `recommendation: "redesign"` を返し、提案自体を再検討する。
- 文化 variant は *実装形式* の差であり、倫理原則は全 variant で同一。

## 9. 関連

- 依存: [relationship-graph-protocol.md](knowledge/public/orchestration/relationship-graph-protocol.md)
- 土台: [pmo/standard/stakeholder_management.md](knowledge/public/pmo/standard/stakeholder_management.md)
- パイプライン: [pipelines/stakeholder-consensus-orchestrator.json](pipelines/stakeholder-consensus-orchestrator.json)

---
_Created: 2026-04-17 as nemawashi-protocol.md | Generalized: 2026-04-20 per CONCEPT_INTEGRATION_BACKLOG P1-2b_
