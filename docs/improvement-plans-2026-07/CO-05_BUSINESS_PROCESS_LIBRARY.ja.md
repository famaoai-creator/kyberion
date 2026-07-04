# CO-05: 事業プロセステンプレートライブラリの拡充

> 優先度: P2 / 規模: M / 依存: MO-01(プロセステンプレート)、CO-02(役割)、CO-03(財務) / 関連: 既存 99 pipeline template、CEO_SCENARIOS
>
> **なぜ重要か**: 会社を回すには「繰り返す事業プロセス」が要る。既存 99 テンプレートは engineering/ops/media 寄りで、経営・管理系(採用・調達・資金調達・取締役会・財務決算)が欠けている。1人+AI 企業の日常業務を型として揃える。

## 背景と課題

- **99 pipeline template は app 寄り**: sales/contract/onboarding/media/eng は揃うが、以下の**基幹業務プロセスが無い**: 採用/リクルーティング、給与/労務、調達/ベンダー管理、資金調達、取締役会ガバナンスの定例、財務決算/照合(請求 PDF のみ存在)、人事評価。`talent_culture` / `line_manager` role は存在するが**裏付けるプロセステンプレートが無い**。
- CEO_SCENARIOS の採用シナリオ(#3)はカレンダー/ブラウザ自動化のパターンで、専用の hiring pipeline template でない。

## ゴール(受入条件)

1. 1人+AI 企業に必要な基幹事業プロセスが pipeline template として揃う(最低: 採用、財務決算/照合、調達、取締役会/経営定例、人事評価、資金調達準備)。
2. 各テンプレートが CO-02 の役割(担当 role)・CO-03 の財務/KPI・CO-04 の決裁権限に接続する(例: 調達は finance の決裁閾値を通る)。
3. 既存の欠落 role(talent_culture, line_manager)に裏付けプロセスが付く。
4. テンプレートが MO-01 のプロセステンプレート(相・ゲート)形式に従い、mission として実行可能。

## 実装タスク

### Task 1: 基幹プロセスの棚卸しと優先順位 — `claude-sonnet-4`

1. 1人+AI スタートアップの業務を棚卸しし、既存 99 テンプレートとのギャップを埋める優先順位を決める(COMPANY_OS_CONCEPT の CEO の1日を参照)。最優先: 財務決算/照合(月次)、採用、経営定例(週次/月次、既存 weekly-executive-digest を核に)。
2. 各プロセスの相(intake→…→delivery、mission-workflow-catalog 形式)と担当 role・決裁点・成果物を設計。本文書末尾に一覧追記。

### Task 2: 経営・財務系プロセス — `claude-sonnet-4`

1. `knowledge/product/pipeline-templates/`(既存99テンプレの場所。リポジトリ直下 `pipeline-templates/` は存在しない — 2026-07-03 レビューで訂正)に追加: `financial-close-monthly`(CO-03 の財務モデルへ記帳・照合・レポート)、`board-meeting-prep`(取締役会資料、既存 ceo-strategic-report を拡張)、`budget-review`(予算対比、CO-03)。
2. finance_controller role(CO-02 で act 化)と CO-04 の決裁権限に接続。外部会計(freee 等)連携は AC-05 に委ね、ここは Kyberion 内のプロセス骨格。
3. テスト: 各テンプレートが mission として起動・実行(stub)。

### Task 3: 人事・調達系プロセス — `claude-sonnet-4`

1. `hiring-workflow`(JD 作成→候補管理→面接調整(CEO_SCENARIO #3 のカレンダー/ブラウザ自動化を取り込む)→評価)、`procurement-vendor`(ベンダー選定→契約(contract-review 連携)→決裁(CO-04))、`performance-review`(人事評価)。
2. 欠落していた `talent_culture` / `line_manager` role に紐付け(CO-02)。
3. テスト: 各テンプレートの起動。

### Task 4: 資金調達準備とカタログ整備 — `claude-haiku`

1. `fundraising-prep`(投資家資料・データルーム準備・KPI サマリ(CO-03))を追加。
2. 全新規テンプレートを `mission-workflow-catalog.json` に登録し、`check:catalogs` を通す。CEO_SCENARIOS.md / USE_CASES.md に新プロセスを追記。

## リスクと注意

- テンプレートを作りすぎて使われない「棚卸し倒れ」を避ける。**実際に市村さんが回す業務**(SBI グループ文脈・deal-tracker 等の既存実運用)を優先し、汎用の理想形でなく実需から作る。
- 財務決算・人事・調達は決裁と機密を伴う。CO-04 の決裁権限・SA の統制・tier 隔離を必ず通す。自動化は「準備・下書き」まで、最終決裁は人間(判断基準の不可逆×広域は人間)。
- 外部システム(会計・ATS・調達)との実連携は AC-05(日本 SaaS)/ AC 系に委ね、本計画は Kyberion 内のプロセス骨格に集中(二重実装しない)。
