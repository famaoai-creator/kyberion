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

## 実装状況 (2026-07-11 突合)

- mission-workflow-catalog.json に **35 テンプレート**が登録済みで、本計画の対象(採用 hiring-workflow / 月次決算 financial-close-monthly / 調達 procurement-vendor / 取締役会 board-meeting-prep / 資金調達 fundraising-prep、加えて budget-review / performance-review 等)を含む。`tests/co-business-process-library-contract.test.ts` が契約として固定(緑)。STATUS の TODO 表記は陳腐化していた。
- 残: 受入条件との全項目突合(テンプレートの phase 構成が計画の要求粒度を満たすかの精査)。

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

## 実装メモ

- 2026-07-05: `knowledge/product/pipeline-templates/financial-close-monthly.json` / `board-meeting-prep.json` / `budget-review.json` を追加し、月次決算・取締役会準備・予算レビューの最小プロセスをテンプレート化した。
- 2026-07-05: `knowledge/product/governance/mission-workflow-catalog.json` に上記 3 テンプレートの選択規則を追加し、`mission-workflow-catalog` から実行相を引けるようにした。
- 2026-07-05: `knowledge/product/pipeline-templates/hiring-workflow.json` を追加し、JD 下書き・面接調整・評価メモまでを採用フローとして型化した。`talent_culture` / `line_manager` の役割に接続する最小経路を実装した。
- 2026-07-05: `knowledge/product/governance/mission-workflow-catalog.json` に `hiring-workflow` の選択規則を追加した。
- 2026-07-05: `knowledge/product/pipeline-templates/procurement-vendor.json` / `performance-review.json` / `fundraising-prep.json` を追加し、調達・人事評価・資金調達準備の最小プロセスをテンプレート化した。
- 2026-07-05: `knowledge/product/governance/mission-workflow-catalog.json` に上記 3 テンプレートの選択規則を追加した。
- 完了: CO-05 の基幹業務テンプレート 6 本を揃え、`mission-workflow-catalog` から選択可能になった。
- 2026-07-06: MO-01 の phaseSpec 機構に載せ、既存 7 テンプレート(procurement-vendor / performance-review / fundraising-prep / hiring-workflow / financial-close-monthly / budget-review / board-meeting-prep)へ**フェーズ別 default_tasks・レビューフェーズ・evidence/human ゲート**を付与した(フェーズ id は不変)。ミッション作成時に NEXT_TASKS.json とゲート定義まで自動展開される。
- 2026-07-06: ライブラリを 7 業務プロセス追加で拡充: `research-report`(調査)/ `data-analysis-report`(データ分析)/ `marketing-campaign-production`(マーケ)/ `contract-review-approval`(契約レビュー)/ `customer-onboarding-engagement`(顧客オンボーディング)/ `training-material-authoring`(研修資料)/ `event-planning-operations`(イベント運営)。すべて intent/mission-type/日本語発話で分類ポリシーからルーティングされる(カタログ v1.2.0)。
- 2026-07-14 再突合: 受入2(CO-04 決裁権限への接続)が未接続と判明 — 各テンプレートは `"approval_boundary": "requires_finance_controller_review"` 等を JSON メモとして書くだけで、`evaluateDecisionRights`/`enforceApprovalGate` を実際に呼ぶ op 呼び出しがゼロだった(調達・採用が金額/人数閾値を実行時に強制していない)。
- 2026-07-15: 受入2を procurement-vendor(operational_spend)/hiring-workflow(headcount_expansion)の2テンプレートで実装。`libs/actuators/wisdom-actuator/src/decision-ops.ts` に `evaluateDecisionRightsApprovalOp`(op: `wisdom:evaluate_decision_rights_approval`)を新設 — `resolveDecisionRightsMatrix`+`evaluateDecisionRights`(CO-04 の既存ロジック、複製せず呼ぶだけ)でエスカレーション要否を事前判定し、要る場合のみ `enforceApprovalGate`(承認リクエストの作成/既存一致/監査記録を持つ既存インフラ)を呼ぶ。両テンプレートの評価ステップ後を `core:if` で分岐し、ブロック時は operator に伝わるログを出す。
  - **発見した構造的欠落と修正**: `enforceApprovalGate` の decision-rights 連携は「エスカレーション不要なら即許可」という fast-path 専用で、エスカレーション**要**の場合は素通しして `approval-policy.json` の intentId ベースの別ポリシーに判定を委ねる作りだった。`decision_type` を payload に積む呼び出しが本 op 追加前はコード全体で0件だったため、CO-04 の決裁権限マトリクス(`operational_spend`/`headcount_expansion`/`contract_signature` すべて `requires_human_acceptance: true`)は一度も実際にブロックを発火したことが無かった。`knowledge/product/governance/approval-policy.json` に `payload_field: "decision_type"` で3種を拾う汎用ルール(`decision-rights-escalation`)を追加して解消。既存呼び出しへの影響なし(追加前に `decision_type` を渡す呼び出しが無いことを確認済み)。
  - **検証**: dist ビルドの実 CLI で procurement-vendor / hiring-workflow を stub reasoning backend で実行し、実際に pending 承認が作成されパイプラインがブロック表示になることを確認(hiring-workflow は無関係な既存バグ2件—preflight fragment の `pnpm doctor --runtime` 未知オプション、calendar 依存ステップ—を除いた縮小版で確認。次の一手にはこの2件のバグ修正は含めない、CO-05 の範囲外)。単体テスト5本新設(`decision-ops.test.ts`)。`pnpm run build`・`build:actuators`・`check:op-registry`・`check:contract-schemas`・`check:catalogs`・`check:golden`・`tests/co-business-process-library-contract.test.ts` すべて緑。
  - **副次的発見(範囲外、要フォローアップ)**: pipeline-templates の `"xxx_path": "...{{mission_id}}...".ext` という context-default の二重テンプレート参照(`"path": "{{xxx_path}}"`)は、`system:write_file`/`write_artifact` 経由では2重解決されず literal `{{mission_id}}` を含むファイル名で書き込まれる(procurement-vendor の `vendor_brief_path`/`comparison_memo_path` で確認済み — 本 op が追加した decision note の書き込みだけはパスを直書きして回避)。他の pipeline-templates への波及範囲は未調査。単一パス関連なので IP/AR 系の別チケット向き。
