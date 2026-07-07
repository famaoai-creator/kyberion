# SaaS・プロダクト開発企業(saas-product-company)

Kyberion にSaaS・プロダクト開発企業を運営させるための会社テンプレート。組織プロファイル・組織図(15ポジション)・チームテンプレートカタログ・顧客ファイル一式を含む。

## 組織構成

- **Leadership & Strategy**: ceo, business_owner, product_manager
- **Engineering & Reliability**: solution_architect, software_developer, qa_lead, reliability_engineer, performance_engineer
- **Sales & Growth**: strategic_sales, marketing_growth, customer_success
- **Governance & Corporate**: pmo_governance, cyber_security, legal_strategist, finance_controller

CEO のみ `held_by: human`(最終決裁は人間)。他ポジションはエージェントが担い、`org-chart.json` で差し替え可能。組織図は CO-02 の方針どおり「既定の出発点」であり、ミッションチームは分類から動的に編成される。

## 使い方

```bash
pnpm company:bootstrap --vertical saas-product-company --slug <会社スラッグ> --name "<会社名>"
export KYBERION_CUSTOMER=<会社スラッグ>
node dist/scripts/mission_controller.js organization-profile --summary
```

主要プロセス: `code-change-aidlc`(開発)、`presentation-deck-production`(提案資料)、`marketing-campaign-production`(マーケ)、`customer-onboarding-engagement`(CS)、`incident-analysis-postmortem`(障害分析)
