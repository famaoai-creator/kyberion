# 業態別 会社テンプレート(Company Templates by Business Type)

Kyberion に「会社」を運営させるための業態別テンプレート。各テンプレートは以下で構成される:

| ファイル                                        | 役割                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `organization-profile.json`                     | 組織プロファイル(既定ミッションクラス・チームテンプレートカタログ・並列度) |
| `org-chart.json`                                | 組織図(ドメイン・ポジション・レポートライン・権限参照)                     |
| `customer.json` / `identity.json` / `vision.md` | 会社エンティティ(CO-01 `resolveCompany` が集約)の構成ファイル              |
| `README.md`                                     | 業態の説明と主要プロセステンプレートへの対応                               |

チームテンプレートカタログは `knowledge/product/governance/organization-team-template-catalogs/<vertical>.json` に置かれ、プロファイルの `team_defaults.team_template_catalog_id` から参照される。

## 収録業態

| ID                              | 業態                                 | 既定ミッションクラス   |
| ------------------------------- | ------------------------------------ | ---------------------- |
| `saas-product-company`          | SaaS・プロダクト開発企業             | product_delivery       |
| `consulting-firm`               | コンサルティングファーム             | decision_support       |
| `marketing-agency`              | マーケティング・クリエイティブ代理店 | content_and_media      |
| `financial-services-backoffice` | 金融・管理部門バックオフィス運営     | operations_and_release |
| `it-managed-services`           | IT運用・マネージドサービス(MSP)      | operations_and_release |

## 実体化(bootstrap)

```bash
pnpm company:bootstrap --vertical saas-product-company --slug acme --name "ACME株式会社"
export KYBERION_CUSTOMER=acme
```

`customer/<slug>/` にプレースホルダ({COMPANY_SLUG} / {COMPANY_NAME})を置換した実体が生成される。組織図・プロファイルは `resolveOrganizationOrgChart` / `loadOrganizationProfile` が customer 優先で解決し、ミッションチーム編成(`composeMissionTeamPlan`)と operator surface に反映される。

関連: 業務プロセス側のテンプレートは `knowledge/product/governance/mission-workflow-catalog.json`(MO-01)、ミッション種テンプレートは `templates/verticals/`(D-2)。
