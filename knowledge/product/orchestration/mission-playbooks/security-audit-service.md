---
title: ミッション・プレイブック：ソースコード・セキュリティ診断サービス
category: Orchestration
tags: [orchestration, mission-playbooks, security, audit, static-analysis, service-delivery]
importance: 9
author: Ecosystem Architect
last_updated: 2026-07-08
---

# ミッション・プレイブック：ソースコード・セキュリティ診断サービス

弊社が第三者としてソースコードの静的解析セキュリティ診断を**サービスとして提供**するための、再現性の高いエンドツーエンド・プロセス。過去の Solana スマートコントラクト診断案件（提案 → 2ラウンド診断 → 最終報告）を kyberion のインテント→ゴール→リザルト・ループに取り込んだもの。別の依頼が来ても同じフロー・同じ承認ゲート・同じチーム構成で完了できる。

このプレイブックは「何を」「どの順で」「誰が」「どこで人間が承認するか」を定義する。実装の実体は以下に分散して登録済み。

| 要素                                             | 実体                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| インテント                                       | `standard-intents.json` の `security-audit-service`（`mission_class: customer_engagement` / `risk_profile: approval_required`） |
| ルーティング                                     | `intent-routing-map.json`（`pipeline_intent_map` / `track_intent_policy_map`）                                                  |
| ミッション・ワークフロー（フェーズ＋承認ゲート） | `mission-workflow-catalog.json` の `security-audit-service` テンプレート                                                        |
| 静的解析エンジン（決定的パイプライン）           | `knowledge/product/pipeline-templates/security-audit-static-analysis.json`                                                      |
| preflight ゲート                                 | `pipelines/fragments/security-audit-preflight.json`                                                                             |
| チーム構成                                       | `organization-team-template-catalogs/it-managed-services.json` の `security_audit`                                              |
| 納品承認ポリシー                                 | `approval-policy.json` の `security-audit-deliver`                                                                              |
| 提案デック生成                                   | `pipelines/fragments/pptx-produce-from-brief.json`（再利用）                                                                    |

## 1. フェーズと承認ゲート

`stage_gated_delivery` パターン。各フェーズは `exit_gate` を満たすまで次に進まない。`human_override` を含むゲートは**人間の承認が必須**。

| #   | フェーズ                 | 種別          | 主な成果物                                  | 退出ゲート             | 人間承認              |
| --- | ------------------------ | ------------- | ------------------------------------------- | ---------------------- | --------------------- |
| 1   | 提案・見積り             | approval      | `evidence/proposal-brief.json` + 提案デック | `PROPOSAL_APPROVED`    | ✅ 顧客承認・NDA/契約 |
| 2   | 監査スコープ・要件合意   | judgment      | `evidence/audit-scope.json`                 | `SCOPE_AGREED`         | ✅ スコープ合意       |
| 3   | preflight                | gate          | semgrep/git/対象確認                        | （自動）               | —                     |
| 4   | 静的解析実行             | deterministic | `evidence/audit-findings.json`              | `STATIC_ANALYSIS_DONE` | —                     |
| 5   | 所見整合・重大度較正     | judgment      | `evidence/audit-findings-aligned.json`      | `FINDINGS_ALIGNED`     | —                     |
| 6   | Round 1 報告書・レビュー | review        | `evidence/audit-report-r1.md`               | `R1_REVIEW_PASSED`     | ✅ 納品判定           |
| 7   | 修正対応検証（Round 2）  | judgment      | `evidence/remediation-verification.md`      | `REMEDIATION_VERIFIED` | —                     |
| 8   | 最終報告書・サインオフ   | approval      | `evidence/audit-report-final.md`            | `FINAL_SIGNOFF`        | ✅ 最終サインオフ     |

`mission_class: customer_engagement` + `risk_profile: approval_required` により**レビューモードは strict** に自動選択され、レジストリ側の全体ゲート（`CONTRACT_VALID` / `SECURITY_READY` / `REQUIREMENTS_COMPLETENESS` / `CUSTOMER_SIGNOFF` / `DELIVERABLE_QUALITY`）も併せて発火する。フェーズ内の `exit_gate` はプロセス固有、レジストリ・ゲートは横断ポリシー。両者は補完関係。

## 2. 勝利条件

- [ ] **提案承認**: `PROPOSAL_APPROVED` を人間承認で通過（顧客承認・NDA/契約前提の確認）。
- [ ] **スコープ固定**: 対象コミット・重大度定義・参照基準・突合対象（ADR/設計）が `audit-scope.json` に確定。
- [ ] **所見の裏付け**: 全所見に安定 FIND-ID・重大度・該当箇所（file:line）・リスク・推奨策があり、ブルーチーム批判で反証された仮説は除外済み。
- [ ] **設計判断の分離**: ADR/設計判断として受容した項目が根拠つきで分離されている。
- [ ] **2ラウンド完結**: Round 1 納品 → 修正コミット検証 → 最終報告書に各所見の [重大度 → 対応状況] 遷移が反映。
- [ ] **サインオフ**: `FINAL_SIGNOFF` を reviewer 承認＋人間承認で通過。

## 3. エージェントチーム構成

`security_audit` テンプレート（`it-managed-services.json`）。team_role は担当スペシャリストにマップされる。

| team_role               | 担当ロール（role_hints） | 責務                                             |
| ----------------------- | ------------------------ | ------------------------------------------------ |
| owner                   | `cyber_security`         | ミッション所有・顧客窓口・ゲート承認の起票       |
| planner                 | `solution_architect`     | 提案・スコープ設計・参照基準の選定               |
| implementer             | `cyber_security`         | 静的解析実行・所見整合・報告書執筆・修正検証     |
| reviewer                | `ruthless_auditor`       | 所見の重大度妥当性・根拠整合・納品品質のレビュー |
| devils_advocate（任意） | `ruthless_auditor`       | 重大所見への反証・過小評価の指摘                 |
| scribe（任意）          | `pmo_governance`         | 証跡・監査ログ・ゲート記録の整備                 |

多視点の脆弱性検証は静的解析パイプライン内の**レッドチーム発散**（`red-team-web-vulnerability-expert` / `-system-auditor` / `-cryptographic-auditor`）と**ブルーチーム相互批判**（`blue-team-secure-architect` / `-qa-engineer`）で担う。重い解析・執筆は `delegateTask()` でサブエージェントに委譲し、メインループのコンテキストを軽く保つ。

## 4. 実行手順（ミッション・ライフサイクル）

```bash
# 1) ミッション作成（confidential ティア・顧客テナント指定）
node dist/scripts/mission_controller.js create MSN-SECAUDIT-<customer> \
  --tier confidential --tenant-slug <customer> \
  --mission-type security-audit-service --intent-id security-audit-service

# 2) チーム編成（security_audit テンプレートを解決）
node dist/scripts/compose_mission_team.js --mission-id MSN-SECAUDIT-<customer> \
  --request "source-code security audit for <customer>" --write

# 3) 起動 → プロセステンプレートをフェーズ・タスク・ゲートに展開
node dist/scripts/mission_controller.js start MSN-SECAUDIT-<customer>
node dist/scripts/mission_controller.js plan-tasks MSN-SECAUDIT-<customer>

# 4) 実行（ゲート未通過で自動停止する）
node dist/scripts/mission_controller.js dispatch-workitems MSN-SECAUDIT-<customer>

# 5) 各承認ゲートを人間が通過させる（例）
node dist/scripts/mission_controller.js gate-pass MSN-SECAUDIT-<customer> PROPOSAL_APPROVED --note "顧客承認・NDA締結済み"
node dist/scripts/mission_controller.js gate-pass MSN-SECAUDIT-<customer> SCOPE_AGREED --note "スコープ合意"
# … 静的解析〜Round1 …
node dist/scripts/mission_controller.js gate-pass MSN-SECAUDIT-<customer> R1_REVIEW_PASSED --note "Round1納品可"
# … 修正検証 …
node dist/scripts/mission_controller.js gate-pass MSN-SECAUDIT-<customer> FINAL_SIGNOFF --note "最終サインオフ受領"

# 6) 検証 → 蒸留 → 封印アーカイブ
node dist/scripts/mission_controller.js verify  MSN-SECAUDIT-<customer> verified "全ゲート通過"
node dist/scripts/mission_controller.js distill MSN-SECAUDIT-<customer>
node dist/scripts/mission_controller.js finish  MSN-SECAUDIT-<customer> --seal
```

静的解析フェーズのパイプラインを単体で回す場合:

```bash
pnpm pipeline --input knowledge/confidential/<customer>/pipelines/security-audit-static-analysis.json
```

## 5. 顧客ごとの実体化（テナント・インスタンス）

再利用テンプレートは product ティア（`knowledge/product/…`）に置き、**顧客固有の実体は confidential ティアに置く**。ティアを跨いだ漏洩は禁止（上位→下位への流出禁止）。

1. `knowledge/confidential/<customer>/pipelines/security-audit-static-analysis.json` を product テンプレートから複製し、`context` を実値で埋める:
   - `target_dir`（対象リポジトリのパス）、`semgrep_config`、`tenant_slug`、`reference_standards`。
   - 言語・フレームワーク固有の観点（例: Solana/Anchor なら Missing Signer Check・Account Ownership・PDA seed・CPI reentrancy）を `topic` に補う。
2. 顧客の重大度定義・レポートテンプレート・ブランドデザイン（提案デック用）を `knowledge/confidential/<customer>/` に配置。
3. 監査対象コード・設計/ADR などの受領物は confidential ティアのミッション証跡に取り込む。

## 6. 成果物スキーマ（統一 content-JSON）

報告書の各イテレーション（所見 → Round1 → 最終）は差分・再レンダリング可能にするため同一スキーマで表現する:

```json
{
  "title": "…セキュリティ監査報告書",
  "summary": "…",
  "sections": [
    {
      "heading": "…",
      "body": ["…"],
      "tables": [{ "title": "…", "columns": ["…"], "rows": [["…"]] }],
      "callouts": [{ "title": "…", "tone": "info|warning|critical", "body": "…" }]
    }
  ]
}
```

所見フォーマット（各 FIND セクション）: `重大度` / `概要` / `該当箇所 (file:line)` / `リスク` / `推奨策`。重大度は `Critical / High / Medium / Low / Informational` の5段階＋対応推奨タイミング。総合評価レーティング（`A / A- / B+ / B`）は判定基準つきで別セクションに定義する。

## 7. 参照

- 過去案件の復元プロセス（提案 → 2ラウンド → 最終報告、承認ゲートの実例）は本プレイブックの原型。
- [product-audit.md](./product-audit.md)（プロダクト健全性監査の姉妹プレイブック）
- [adf-pipeline-quickstart.md](../adf-pipeline-quickstart.md)（ドラフト → preflight → コミット → 実行の規律）
- `AUDIT_REPORT_TEMPLATE.md` / `SECURITY_AUDIT_REQUIREMENTS.md`（レポート雛形・要件雛形；顧客案件の vault 側に配置）
