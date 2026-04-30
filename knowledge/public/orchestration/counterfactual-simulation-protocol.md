---
title: Counterfactual Simulation Protocol
category: Orchestration
tags: [orchestration, decision, counterfactual, simulation, creative]
importance: 7
author: Ecosystem Architect
last_updated: 2026-04-17
---

# Counterfactual Simulation Protocol

重大判断の直前に「もし別の選択肢を取っていたら」を短期シミュレーションする手続き。判断責任を人間側に残したまま、trade-off を可視化する。

## 1. いつ使うか

以下のいずれかに該当する場合に **強制適用** を推奨する:

- Mission priority が 8 以上 (金銭・組織・外部契約に直結する判断)
- `hypothesis-tree-protocol.md` による 2 本以上の「拮抗する生存仮説」が存在する
- 操作者が `--counterfactual` フラグを明示指定した場合

## 2. 実行原則

- **Fork**: orchestrator-actuator が mission-local の Git worktree を 2〜N 個フォークし、各仮説ごとに時間上限付き simulation を走らせる。
- **コスト上限**: 1 分岐あたり最大 10 ツール呼び出し、最大 $X トークン (judgment-rules.json の `counterfactual.cost_cap` で定義)。
- **到達目標**: 「最初のリスク事象が顕在化するまでの推定ステップ数」または「想定成果が得られるまでの推定ステップ数」のいずれか早い方まで。
- **Merge**: 各分岐の短期結果は `evidence/counterfactual-branches/` に集約。本流ミッションには **コードをマージしない**。あくまで meta evidence として参照のみ。

## 3. 出力フォーマット

```json
{
  "mission_id": "string",
  "counterfactual_topic": "string",
  "branches": [
    {
      "branch_id": "A",
      "hypothesis_ref": "hypothesis-tree.json#/hypotheses/2",
      "first_failure_mode": "string | null",
      "first_success_mode": "string | null",
      "steps_consumed": "number",
      "narrative": "string (<500 chars)"
    }
  ],
  "comparative_summary": "string",
  "timestamp": "ISO-String"
}
```

## 4. 安全弁

- **副作用禁止**: 分岐内での `system:shell` 実行、外部 API 書き込み、送信系 actuator の呼び出しは拒否する (execution-boundary-profiles.json の `profile: "counterfactual"` で制御)。
- **証跡固定**: 各分岐は独立した Git branch に固定され、本流との hash 関係が dissent-log.json から辿れる。

## 5. 関連

- 前提: [hypothesis-tree-protocol.md](knowledge/public/orchestration/hypothesis-tree-protocol.md)
- 実行枠: [execution-boundary-profiles.json](knowledge/public/governance/execution-boundary-profiles.json)
- パイプライン: [pipelines/counterfactual-branch.json](pipelines/counterfactual-branch.json)

---
_Created: 2026-04-17 | Ecosystem Architect_
