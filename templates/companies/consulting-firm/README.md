# コンサルティングファーム(consulting-firm)

Kyberion にコンサルティングファームを運営させるための会社テンプレート。組織プロファイル・組織図(12ポジション)・チームテンプレートカタログ・顧客ファイル一式を含む。

## 組織構成

- **Partners & Leadership**: ceo, business_owner
- **Consulting & Research**: solution_architect, knowledge_steward, ruthless_auditor, pmo_governance
- **Client Relations**: strategic_sales, customer_success, executive_assistant
- **Corporate**: legal_strategist, finance_controller, talent_culture

CEO のみ `held_by: human`(最終決裁は人間)。他ポジションはエージェントが担い、`org-chart.json` で差し替え可能。組織図は CO-02 の方針どおり「既定の出発点」であり、ミッションチームは分類から動的に編成される。

## 使い方

```bash
pnpm company:bootstrap --vertical consulting-firm --slug <会社スラッグ> --name "<会社名>"
export KYBERION_CUSTOMER=<会社スラッグ>
node dist/scripts/mission_controller.js organization-profile --summary
```

主要プロセス: `research-report`(調査)、`data-analysis-report`(分析)、`presentation-deck-production`(報告書・提案書)、`board-meeting-prep`(経営会議支援)、`contract-review-approval`(契約)
