# KPI Tracking — LLM コスト会計(OP-01)

評価レポートが参照する KPI 正本。コスト系 KPI のデータソースは usage ledger(`work/metrics/execution-metrics.jsonl`)であり、集計は `pnpm cost:report` が単一の入口。

## FDE 向けコスト KPI

| KPI                    | 定義                                                 | 取得コマンド                                |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------- |
| ミッションあたりコスト | ミッション別累計 USD(sdk 実コスト優先、無ければ概算) | `pnpm cost:report -- --json` → `by_mission` |
| 週次スパン             | 直近7日の合計 USD(estimated 分は分離表示)            | `pnpm cost:report -- --last-days 7`         |
| 月次スパン             | 直近30日の合計 USD                                   | `pnpm cost:report -- --last-days 30`        |
| 日次バーン             | 日別 USD 推移                                        | `pnpm cost:report -- --json` → `by_day`     |

## 可視化経路

- **operator packet / status report**: 直近7日のコストとミッション別 top3 を findings に表示(`weekly-cost`、metrics に `weekly_cost_usd`)。
- **週次サマリ(KM-01)**: weekly-review パイプラインが `cost_report --last-days 7` を実行。
- **上限制御(spend-guard)**: `knowledge/product/governance/spend-policy.json` の日次/ミッション cap(+ `tenant_overrides` によるテナント別 cap/posture)。warn(既定)→ block の段階導入。超過は ops-alert に日次 dedupe で通知。

## 運用ルール

1. 見積り(`estimated`)と実測は混ぜて解釈しない — レポートの分離表示を正とする。
2. cap の引き締め(warn → block、金額縮小)は warn での実測分布を確認してから行う(共通作業規約4: 観測→enforce)。
3. テナント別の商談・請求根拠には `by_mission` を用い、ミッション ↔ テナントの対応は mission メタデータを正とする。

→ 関連: [OP-01 計画](./developer/improvement-plans-2026-07/OP-01_COST_ACCOUNTING.ja.md) · [CO-03 財務 KPI モデル](./developer/improvement-plans-2026-07/CO-03_FINANCIAL_KPI_MODEL.ja.md)
