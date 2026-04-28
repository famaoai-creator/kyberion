---
title: Intent-Contract Learning Design
category: Architecture
tags: [intent, adf, pipeline, learning, routing, receipt]
importance: 9
author: Codex
last_updated: 2026-04-29
---

# Intent-Contract Learning 設計

## 1. 目的

ユーザー要求（Intent）に対して、過去の実行結果を学習して次回の契約選択（ADF / Pipeline / Task Session / Mission）を改善する。

狙いは次の 3 点。

1. 再実行性の向上（同じ要求に同じ品質で応答）
2. 成功率の向上（失敗しにくい契約を優先）
3. 説明可能性の向上（なぜその実行経路を選んだか追跡可能）

## 2. コンセプト

```text
Request
-> Intent Resolution
-> Contract Candidate Selection (learned ranking)
-> Governance Gate
-> Execution
-> Receipt
-> Learning Update
```

既存の `intent -> execution` を壊さず、間に「学習された契約選択レイヤー」を追加する。

## 3. コア要素

### 3.1 Intent-Contract Memory

過去成功/失敗を `intent_id` 単位で蓄積するメモリ。

最小レコード例:

```json
{
  "intent_id": "execute-points-portal-clickout",
  "context_fingerprint": {
    "domain": "travel",
    "merchant": "rakuten_travel",
    "locale": "ja-JP"
  },
  "contract_ref": {
    "kind": "schema",
    "path": "knowledge/public/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json"
  },
  "execution_shape": "task_session",
  "success_rate": 0.86,
  "sample_count": 21,
  "last_seen": "2026-04-29T00:00:00.000Z"
}
```

### 3.2 Contract Candidate Selector

Intent から実行候補を複数抽出し、以下でスコアリングする。

- ルール適合 (`intent-domain-ontology`)
- 過去成功率 (`Intent-Contract Memory`)
- 最近失敗ペナルティ
- 実行コスト（latency / external dependency）

出力は上位N候補（例: 3件）。

### 3.3 Governance Gate

高リスク intent では候補の自動選択を制限する。

- `risk_profile = high_stakes` は approval 必須
- `fallback_allowed = false` は deterministic path 優先
- tier 境界を跨ぐ場合は sanitize evidence 必須

### 3.4 Execution Receipt Standardization

全実行で共通 receipt を強制。

```text
request -> intent_resolution -> candidate_selection -> gate -> execution -> verification -> result -> memory_update
```

## 4. データモデル

### 4.1 新規 Governance Artifact

1. `knowledge/public/governance/intent-contract-memory.json`
2. `knowledge/public/governance/intent-contract-selection-policy.json`
3. `knowledge/public/schemas/intent-contract-memory.schema.json`
4. `knowledge/public/schemas/intent-contract-selection-policy.schema.json`

### 4.2 既存との接続

- `standard-intents.json`: intent 正本
- `intent-domain-ontology.json`: target/action/object + governance
- `intent-coverage-matrix.json`: 実行カバレッジ
- `execution-receipt` 系: 学習更新ソース

## 5. ルーティング戦略

### 5.1 実行形別

1. `pipeline`: deterministic 実行を最優先
2. `mission/task_session`: learned ranking で contract 推奨
3. `direct_reply`: 低リスク時のみ軽量実行

### 5.2 旅行例（楽天トラベル）

ユーザー発話: 「楽天トラベルで鹿児島の最安を教えて」

- Intent解決: `execute-points-portal-clickout` (将来追加) または `live-query`
- 候補契約:
  1. `points-portal-clickout-usecase`（ポイント経由）
  2. `live-query direct web search`（即答）
- Policy:
  - points優先設定あり -> 1を優先
  - 証跡不足時 -> 2へフォールバック
- Receipt保存後に成功率更新

## 6. 学習更新ルール

### 6.1 更新入力

- 実行成功/失敗
- 手戻り有無
- 承認差し戻し有無
- 出力品質シグナル（再依頼率、修正率）

### 6.2 更新方式（初期）

- 単純移動平均（SMA）
- 最低サンプル数ゲート（例: `sample_count >= 5` で強推奨）
- 直近失敗に重み付け（penalty boost）

## 7. 導入ステップ

### Phase 1: 観測強化

- receiptに `candidate_selection` を追加
- memoryへの書き込みのみ（読み出し未適用）

### Phase 2: 提案モード

- 候補提示だけ行い、実行は現行ルート
- operatorが採用/不採用を選ぶ

### Phase 3: 自動選択

- 低リスク intent で自動選択有効化
- 高リスクは承認必須維持

### Phase 4: 継続最適化

- drift検知
- counterfactual replay（失敗ケース比較）

## 8. メリット/デメリット

### メリット

- 同種要求への安定応答
- 失敗パターンの早期回避
- ガバナンス説明が容易

### デメリット

- 初期実装/運用コスト増
- 更新漏れ時の誤学習リスク
- 過学習による探索力低下

## 9. リスク対策

1. CIで memory schema と policy schema を強制
2. `stale_rule_ttl_days` を設けて古い学習を減衰
3. high_stakes intent は人間承認を維持
4. fallback path を常に保持

## 10. 受け入れ基準

1. `intent -> contract candidate -> selected` が receiptで追跡できる
2. 学習更新の before/after が比較可能
3. 低リスク intent で成功率が有意に改善
4. validate / governance checks が継続通過

