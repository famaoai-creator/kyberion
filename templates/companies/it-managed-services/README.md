# IT運用・マネージドサービス(MSP)(it-managed-services)

Kyberion にIT運用・マネージドサービス(MSP)を運営させるための会社テンプレート。組織プロファイル・組織図(12ポジション)・チームテンプレートカタログ・顧客ファイル一式を含む。

## 組織構成

- **Leadership**: ceo, business_owner
- **Service Operations**: reliability_engineer, incident_commander, infrastructure_sentinel, performance_engineer
- **Engineering & Integration**: solution_architect, integration_steward, cyber_security
- **Service Management**: customer_success, pmo_governance, finance_controller

CEO のみ `held_by: human`(最終決裁は人間)。他ポジションはエージェントが担い、`org-chart.json` で差し替え可能。組織図は CO-02 の方針どおり「既定の出発点」であり、ミッションチームは分類から動的に編成される。

## 使い方

```bash
pnpm company:bootstrap --vertical it-managed-services --slug <会社スラッグ> --name "<会社名>"
export KYBERION_CUSTOMER=<会社スラッグ>
node dist/scripts/mission_controller.js organization-profile --summary
```

主要プロセス: `incident-analysis-postmortem`(障害分析)、`gated-incident-containment`(封じ込め)、`code-change-aidlc`(改修)、`customer-onboarding-engagement`(サービス導入)、`data-analysis-report`(SLA 報告)
