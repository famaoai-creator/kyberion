# CO-03: 財務・KPI・OKR モデリング

> 優先度: P1 / 規模: M〜L / 依存: CO-01(会社エンティティ)、OP-01(コスト会計) / 関連: finance_controller role、CEO_SCENARIOS の OKR/月次レポート
>
> **なぜ重要か**: 「会社を経営する」には数字が要る。今は財務が文字列、KPI/OKR がレポート生成パターンのみで、P&L・予算・予測・OKR がモデル化されていない。経営判断(finance_controller のコスト削減モード等)の根拠となるデータ層。

## 背景と課題

- **財務が経営データとして構造化されていない**: `customer/{slug}/customer.json` の `financials_prev_fy` は**オブジェクト** `{revenue_jpy, profit_jpy, note}`(値は数値文字列。「文字列」ではない — 2026-07-03 レビューで訂正)。ただし前期実績1点のみで、**財務諸表モデルも予算 primitive も予測エンティティも無い**。finance_controller は `evidence/cost-report.json` を書く。
- **KPI/OKR がモデルでない**: OKR 追跡は CEO_SCENARIO のレポート生成パターン(`ceo-strategic-report`)のみで、KPI/OKR の schema も追跡オブジェクトも無い。
- OP-01 で LLM コスト会計は入るが、それは「運用コスト」であって「会社の財務・KPI」ではない(補完関係)。

## ゴール(受入条件)

1. **財務モデル**: P&L・キャッシュ・予算・予測を表現する schema と、実績を記録・集計する仕組み。`customer.json` の文字列財務を構造化データへ。
2. **KPI/OKR モデル**: Objective・Key Result・KPI を構造化(目標値・現在値・期日・オーナー role)。進捗が追跡・可視化される。
3. **経営判断への接続**: finance_controller の「コスト削減モード」等が、この財務データ + OP-01 のコスト会計を根拠に発火できる(判断基準ルーブリックの入力に)。
4. CO-01 の Company エンティティに `financial_ref` で紐付き、SU-04 のコスト可視化・ダッシュボードに表示される。

## 実装タスク

### Task 1: 財務モデル — `claude-sonnet-4`

1. `schemas/financial-model.schema.json`: P&L(収益/費用/利益)・キャッシュフロー・予算(期別・部門別)・予測。`customer.json` の `financials_prev_fy`(既にオブジェクト)をこのモデルへ移行・拡張(数値文字列→数値化、時系列化、後方互換の読み替え)。
2. `libs/core/financial-model.ts`: 財務データの読み書き・期別集計。実績入力は mission(請求処理・経費等)や手動から。confidential tier(財務は機密)。
3. OP-01 の LLM コスト(運用費)を財務モデルの費用項目の1つとして取り込む。
4. テスト: P&L 集計、予算対比、tier 隔離。

### Task 2: KPI/OKR モデル — `claude-sonnet-4`

1. `schemas/okr.schema.json`: `{ objective, key_results: [{ metric, target, current, due, owner_role }], period }` + KPI 定義。
2. `libs/core/okr-tracker.ts`: OKR/KPI の登録・進捗更新・達成率計算。現在値は mission 成果や財務モデル(Task 1)や運用メトリクス(OP-04)から自動更新できる経路を1つ用意。
3. 構想評価レポート §6 の提言「経営者価値の指標を K 系に追加」をここで実体化(委任タスク完遂数・承認往復時間等の経営 KPI)。
4. テスト: OKR 進捗追跡、自動更新。

### Task 3: 経営判断への接続 — `claude-sonnet-4`

1. finance_controller role(`roles/finance_controller/PROCEDURE.md` の「コスト削減モード」)が、財務モデル + OP-01 コスト + 予算対比を根拠に発火する経路。判断基準 AUTONOMOUS_MAINTENANCE_JUDGMENT のルーブリック入力に財務シグナルを追加。
2. 予算超過・KPI 未達を OP-04 の劣化検知/AO-03 のエスカレーションに接続(「予算の 90% を消費」「主要 KR が期日に対し遅延」で通知)。
3. テスト: 予算超過での通知、KPI 遅延での警告。

### Task 4: 可視化 — `claude-haiku`

- SU-04(コスト可視化)/ SU-01(ホーム)に財務サマリ・OKR 進捗を表示。`ceo-strategic-report` パイプラインが生成でなくこのモデルを参照する形に。CO-01 の Company エンティティに紐付け。

## リスクと注意

- 財務データは最高機密。confidential tier 厳守、SA-04 の egress で外部漏洩防止、SA-01 の監査。ダミーテナントでテスト。
- KPI 自動更新は誤った数値を経営判断に流すリスク。自動更新の source を明示し、手動確認/上書きを許す。confidence の低い自動値は「要確認」フラグ。
- 完全な会計システムを作るのではない(それは会計ソフトの仕事)。ここは「経営判断に必要な財務・KPI の構造化と、Kyberion の判断ループへの接続」に絞る。外部会計ソフト(freee 等)との連携は AC-05 の日本 SaaS 連携に委ねる。

## 実装メモ

- 2026-07-05: `libs/core/financial-model.ts` を追加し、`customer/{slug}/customer.json` の legacy `financials_prev_fy` と confidential 配下の `financial-model.json` を構造化して読めるようにした。
- 2026-07-05: `knowledge/product/schemas/financial-model.schema.json` を追加し、Company 集約の `financial_ref` から財務 period の要約を参照できるようにした。
- 2026-07-05: `libs/core/okr-tracker.ts` / `knowledge/product/schemas/okr.schema.json` を追加し、財務・mission・運用メトリクスから OKR/KPI を自動更新できる最小経路を実装した。
- 2026-07-05: `libs/core/finance-controller.ts` を追加し、財務モデル + OKR + OP-01 のコストレポートから `growth` / `monitor` / `cost_cutting` を決める経営判断フローを実装した。Chronos / sovereign dashboard の Company Context にも finance controller 要約を表示するようにした。
- 2026-07-14 精査: Task3 の「予算超過・KPI 未達を OP-04 の劣化検知/AO-03 のエスカレーションに接続」が未実装と判明(`resolveFinanceControllerDecision` は decision mode を計算しダッシュボードに表示するのみで、`degradation-watch.ts` / `ops-alert.ts` のどちらからも参照されていなかった)。
- 2026-07-14 完了: `libs/core/health-degradation.ts` に `budget_or_kpi_signal` finding を追加(finance controller の `cost_cutting` → critical / `monitor` → warning)。`evaluateDegradation`/`runDegradationWatch` は `financeDecision` を opt-in 注入するだけで、未指定時は既存呼び出しの決定性を維持(テスト側で明示的に注入)。`scripts/health_degradation_watch.ts`(hourly cron)に `resolveFinanceControllerDecision()` を渡す配線を追加し、実運用でも予算超過/KPI遅延が AO-03 ops-alert 経由で実際に通知されるようにした。テスト5本追加、全緑・typecheck緑・CLI実行確認済み。AUTONOMOUS_MAINTENANCE_JUDGMENT ルーブリックは既に「OP-04 危険域」を人間呼び出しの条件としており、財務シグナルはこの既存経路を通じて判断ループへ接続される。
