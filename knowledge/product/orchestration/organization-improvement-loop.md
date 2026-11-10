---
title: '目的駆動の改善ループ — improvement-scan'
tags: [orchestration, organization, improvement, dots, cost, okr]
last_updated: 2026-11-08
status: active
---

# 目的駆動の改善ループ (organization improvement loop)

組織の Purpose/Objectives とのギャップから改善点を**発見**し、既存のガバナンス経路で実行に移すループ。closed organization loop (DL-01..11) の上に乗る「発見層」であり、新しい書き込み経路は作らない。

## 構成

```
Purpose record (objectives + KRs)
        │
        ▼ 週次 (org-improvement dot / 手動)
core:organization_improvement_scan  ── read-only ──▶ OrganizationImprovementScanReport
  - objective progress + unmeasured_krs (rollUpObjectiveProgress)
  - KR 停滞 (org-kr-ledger 直近3点で非改善)
  - outcome verdicts (org dots の outcomes.jsonl、連続非改善ストリーク)
  - operations friction (overdue/incidents/decisions/services)
  - cost (usage ledger → by_model/by_mission、前期比、unknown_cost_calls)
        │
        ▼ candidates[] {rule_id, target_kind, expected_kr_effect, priority_score}
standup/retro・org-improvement dot・人間が triage
        │
        ▼ target_kind ごとの昇格先 (既存 governed facade のみ)
pipeline/runbook → mission / pipelines PR
charter          → dot_lifecycle_writer ロール (dot は自契約を書き換え不可)
kr_definition    → pnpm organization (purpose record 更新, approval_state gated)
process          → organization decision → standup 提示
cost/measurement → mission または ops 調整
        │
        ▼ 実行後
WorkItem.expected_effect → KR 再測定 → outcome verdict → 次スキャンへ反映
検証済み改善 → organization-learning-candidate → knowledge/SOP 昇華
```

## コストを目的管理へ組み込む

`KEY_RESULT_ORG_METRICS` はコスト系 org metric を持つ。KR / 目的の KR として
`{source: org_metric, metric: cost_usd|llm_tokens|llm_calls|unknown_cost_calls, window_days}`
を宣言できる (window 既定 7日、最大 90日)。同じ値が continuous-operations の
`organization_metrics` ソースに `*_7d` 名で現れるので、閾値ルールも書ける。

- `cost_usd`: usage ledger の cost 合計 (scope = org + tenant)
- `llm_tokens`: prompt+completion+cache read/write の合計
- `llm_calls`: 実行呼び出し数
- `unknown_cost_calls`: `cost_status=unknown` の呼び出し数 — **コスト可視性そのもののギャップ**

## 運用

```bash
# 手動スキャン (read-only, 書き込みなし)
node --import ./scripts/ts-loader.mjs scripts/organization_improvement_scan.ts \
  --org <org-id> --tenant <slug> --tier confidential --window-days 30

# governed 実行: dots/org-improvement.json を review して status: draft → active
# (activation は gated; allowed_pipelines に scan のみ、decisions floor は approve)
```

apply モード (スコープ付き artifact 発行) は dot executor の検証済み claim
(dot_id + in-progress WorkItem + active lease) を必須とし、
`continuous_operations_report` と同じ claim 契約に従う。
v1 では `pipelines/organization-improvement-scan.json` が `"apply": false` を
ピンしており、パイプライン経路は常に読み取り専用レポートを返す — 意図的な
保守設定であり、artifact 永続化を有効にするには claim 経路の運用実績と
governance review が前提となる。

## 境界

- scan は読み取り専用。候補はすべて `status: proposed` の提案であり、
  dispatch gate / 人間承認なしに実行されない。
- `policy_change`・`cross_tenant`・`lower_tier_write` は `never_auto` で常に人間判断。
- Purpose record の変更は `approval_state` フローで人間承認 — ループが目的自体を
  書き換えることはない。
- candidate_id は内容ハッシュ由来で再実行間で安定 — 重複起票を抑止する。

関連: [resident-dot-model](../architecture/resident-dot-model.md) "The closed organization loop" ·
[delegated-autonomous-loop](../governance/delegated-autonomous-loop.md) ·
[organization-operations-runbook](../governance/organization-operations-runbook.md)
