# 金融・管理部門バックオフィス運営(financial-services-backoffice)

Kyberion に金融・管理部門バックオフィス運営を運営させるための会社テンプレート。組織プロファイル・組織図(11ポジション)・チームテンプレートカタログ・顧客ファイル一式を含む。

## 組織構成

- **Leadership**: ceo, line_manager
- **Finance & Accounting**: finance_controller, ruthless_auditor
- **Governance / Risk / Compliance**: pmo_governance, legal_strategist, cyber_security
- **Operations & Systems**: integration_steward, infrastructure_sentinel, executive_assistant
- **People**: talent_culture

CEO のみ `held_by: human`(最終決裁は人間)。他ポジションはエージェントが担い、`org-chart.json` で差し替え可能。組織図は CO-02 の方針どおり「既定の出発点」であり、ミッションチームは分類から動的に編成される。

## 使い方

```bash
pnpm company:bootstrap --vertical financial-services-backoffice --slug <会社スラッグ> --name "<会社名>"
export KYBERION_CUSTOMER=<会社スラッグ>
node dist/scripts/mission_controller.js organization-profile --summary
```

主要プロセス: `financial-close-monthly`(月次決算)、`budget-review`(予算)、`procurement-vendor`(調達)、`contract-review-approval`(契約審査)、`performance-review`(人事評価)、`board-meeting-prep`(取締役会)、`incident-analysis-postmortem`(事務事故分析)
