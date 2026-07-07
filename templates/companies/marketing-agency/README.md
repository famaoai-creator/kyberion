# マーケティング・クリエイティブ代理店(marketing-agency)

Kyberion にマーケティング・クリエイティブ代理店を運営させるための会社テンプレート。組織プロファイル・組織図(11ポジション)・チームテンプレートカタログ・顧客ファイル一式を含む。

## 組織構成

- **Leadership**: ceo, business_owner
- **Creative & Content**: marketing_growth, designer, knowledge_steward
- **Account & Client**: strategic_sales, customer_success, executive_assistant
- **Corporate & Compliance**: legal_strategist, finance_controller, qa_lead

CEO のみ `held_by: human`(最終決裁は人間)。他ポジションはエージェントが担い、`org-chart.json` で差し替え可能。組織図は CO-02 の方針どおり「既定の出発点」であり、ミッションチームは分類から動的に編成される。

## 使い方

```bash
pnpm company:bootstrap --vertical marketing-agency --slug <会社スラッグ> --name "<会社名>"
export KYBERION_CUSTOMER=<会社スラッグ>
node dist/scripts/mission_controller.js organization-profile --summary
```

主要プロセス: `marketing-campaign-production`(キャンペーン)、`presentation-deck-production`(企画書)、`document-authoring`(記事・ホワイトペーパー)、`event-planning-operations`(イベント・ウェビナー)
