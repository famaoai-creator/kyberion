# MO-01: ミッションタイプの実効化 — 分類がプロセスを駆動する状態にする

> 優先度: **P0**(MO 系の起点) / 規模: M / 依存: なし / 後続: MO-02(型別ゲート)
>
> **参考にしたハーネス原則(Fable 5)**: タスクは「型」ごとに異なる実行形(understand → design → implement → review の相、必要な検証、既定のエージェント編成)を持つ。型が決まればプロセス・ゲート・成果物要件が決定論的に決まり、LLM の即興に頼らない。

## 背景と課題

ミッションの「型」は3系統あるのに、実行を駆動しているのは**ほぼ常に `'development'` に既定される自由文字列**で、分類は飾りになっている。

- `mission_type` は自由文字列で、`createMission`/`startMission` の既定が `'development'`(`scripts/mission_controller.ts:339,408`)。orchestration worker も同様に既定(`libs/core/mission-orchestration-worker.ts:141-149`)。この文字列が**そのままチーム テンプレートのキー**になる(`mission-team-plan-composer.ts:148,154`)。
- 一方、ポリシー駆動の分類器は 9 クラス + 配送形状 5 + リスク 4 + ステージ 9 の 4 軸を持つ(`libs/core/mission-classification.ts:6-38`、`resolveMissionClassification` `:219-260`)— **計算はされる**(`mission-team-plan-composer.ts:139`)が、クラス→テンプレートのマップで 9 クラスが約 5 テンプレートに潰れ(`mission-classification.ts:269-288`。decision_support / content_and_media / code_change → すべて `development`)、実行プロセスの差異が消える。
- `mission-task-classification-roadmap-5.4-mini.md` 自身が「クラス別ワークフロー/ゲート整備」を未了課題として挙げている(Phase A-D)。AI-DLC playbook(`docs/developer/playbooks/AI_DLC_PLAYBOOK.md`)はゲート付き SDLC を人間向けに規定するが、自動 worker はそれを実装していない。

## ゴール(受入条件)

1. ミッション作成時に `MissionClass`(9クラス)+ リスク + 配送形状が**必ず**確定・永続化され、`mission_type` 自由文字列は後方互換の別名に格下げされる。
2. クラスごとに**プロセステンプレート**(フェーズ列・各フェーズの必須ゲート・必須成果物・既定チーム編成・並列度)が宣言的に定義され、orchestration worker がそれを読んで実行する。最低 4 テンプレートを定義: `code_change`(SDLC/AI-DLC 型)、`research_and_absorption`、`content_and_media`、`operations_and_release`。
3. `code_change` テンプレートは AI-DLC playbook の相構造(Alignment → Execution → Test → Self-Review → Circuit-Breaker)をコード化したものになる。
4. 分類結果と適用テンプレートがミッション状態(`state.json`)と operator packet に表示される。

## 実装状況 (2026-07-05)

- **完了(受入1)**: `createMission` が team plan composer の分類結果(`mission_classification`)を `mission-state.json` の `classification` として必ず永続化。`startMission` は分類なしの既存ミッションを activation 時に lazy 分類して backfill(失敗許容)。`mission_type` 自由文字列は型上「後方互換ヒント」として明記格下げ(`scripts/refactor/mission-types.ts`)。
- **完了(受入2 相当)**: プロセステンプレートは既存の **mission-workflow-catalog**(`knowledge/product/governance/mission-workflow-catalog.json` + `resolveMissionWorkflowDesign`)が担うことを確認。クラス別テンプレートは research(explore-then-govern / crystallize-then-freeze)、content(governed-content-narration ほか)、operations(多数)が既存。**欠けていた `code_change` 専用テンプレート `code-change-aidlc` を追加**(`applies_to: code_change × mission`)。
- **完了(受入3)**: `code-change-aidlc` は AI-DLC の相構造をフェーズ列で表現: `intake → classification → alignment → planning → contract_authoring → execution → test → self_review → verification → delivery → retrospective`(circuit-breaker/ゲート実効化は MO-02)。
- **完了(受入4)**: 選択結果は `state.json`(`classification` / `process_template`)、TASK_BOARD.md ヘッダ(Class/Process 行)、`mission_controller status`(Class/Process 表示)に出る。
- **テスト**: `mission-workflow-catalog.test.ts` に「code_change → code-change-aidlc(AI-DLC フェーズ含有)」「クラス3種で異なるテンプレートが選ばれる」を固定。

## 実装状況 追記 (2026-07-06) — フェーズの実タスク展開まで完了

プロセステンプレートが「フェーズ名ラベル」止まりだった残余を解消し、**フェーズ → 具体タスク/ゲートへの決定的展開**まで実装した。当初案の `schemas/mission-process-template.schema.json` + `mission-process-templates/` ディレクトリは**正式に廃案**とし、mission-workflow-catalog の phases を `string | phaseSpec` の oneOf に拡張する方式で確定(既存テンプレートは無変更で後方互換)。

- **スキーマ**: `mission-workflow-catalog.schema.json` v1.1.0 — phaseSpec = `{ id, title?, kind?, pipeline_ref?, brief_ref?, entry_gate?, exit_gate?, default_tasks[] }`。gate check 語彙は mission-gate-engine と同一 + `deliverable_quality`。
- **展開エンジン**: `libs/core/mission-process-task-expansion.ts` — `expandProcessTemplateTasks()` が phase specs を依存連鎖つき `NEXT_TASKS.json`(`origin: process_template` マーカー付き)へ決定的展開。reviewer 不変条件(review_target / REVIEW-\*.md)を展開時に自己検査。
- **接続**: `createMission` で default_tasks があれば自動展開 + TASK_BOARD.md にフェーズ別チェックリスト描画。既存ミッションは `mission_controller plan-tasks <ID> [--force]`。ゲート定義は `missions/<id>/gates/definitions/` に永続化。
- **ゲート実効化(MO-02 の先行分)**: `gate-pass`/`gate-fail` が保存済み定義を `evaluateMissionGate` で機械評価(pass で `current_phase` 前進、fail でフェーズタスクを rework 化)。workitem dispatch は entry_gate 未通過フェーズのタスクを `deferred`。`deliverable_quality` check(`evaluateDeliverableQuality` ルーブリック、MO-07 の接続点)を gate-engine に追加。
- **プロセステンプレート(3系統 + 文書)**: `presentation-deck-production`(顧客層定義 → ストーリー設計 → コンテンツ執筆 → デザイン選定 → レビュー → 成果物作成。production は `pipelines/fragments/pptx-produce-from-brief.json` を参照)、`document-authoring`、`incident-analysis-postmortem`(triage → evidence_collection → timeline_reconstruction → root_cause_analysis → review → report_delivery)、既存 `code-change-aidlc` に各フェーズの pipeline_ref + default_tasks + ゲートを付与(フェーズ id 不変)。
- **worker 統合**: `persistPlanningPacket` は `origin: process_template` タスクを保護マージ(プランナーは追加のみ可)。planner kickoff プロンプトにフェーズ骨子と固定タスク一覧を注入。
- **分類ルーティング**: `mission-classification-policy.json` に `presentation_production`/`document_production` → `content_and_media`、`incident_analysis` → `operations_and_release` のヒント/インテント/発話ルールを追加(`mission create <ID> --mission-type presentation_production` だけで専用プロセスに載る)。`resolveMissionWorkflowDesign` にも同ヒントの intent 既定値を追加。
- **検証**: `pnpm check:workflow-catalog-refs`(`scripts/check_workflow_catalog_refs.ts`、validate チェーンに追加)が pipeline_ref/brief_ref の実在と全テンプレートの展開可否を静的検査。stub バックエンドでの E2E(create → gate-pass fail/pass → current_phase 前進)を手動確認済み。
- **残余(後続 IP へ)**: worker イベント連鎖のフェーズ駆動化の残り(MO-02)、`crossCritique`/best-of-N のレビュー接続(MO-07)、成果物インボックス UI(SU-03)。
- **2026-07-06 拡充**: カタログ v1.2.0 でプロセスライブラリを全 16 業務プロセスに拡大 — CO-05 の 7 ビジネステンプレートに phaseSpec を付与し、新規 7 テンプレート(research-report / data-analysis-report / marketing-campaign-production / contract-review-approval / customer-onboarding-engagement / training-material-authoring / event-planning-operations)を追加。分類ポリシーに各パターンの hint/intent/日本語発話ルールを追加(詳細は CO-05 実装メモ)。

## 実装タスク

### Task 1: プロセステンプレートのスキーマ設計 — `claude-opus`(設計)

1. 既存のチームテンプレート(`mission-team-plan-composer.ts` が読む形式)と `MissionTeamLifecyclePolicy` を読み、これを包含する **process template** スキーマを設計する: `{ mission_class, phases: [{ id, entry_gate?, required_evidence[], default_tasks_shape, exit_gate }], team_template, max_parallel_members, risk_overrides }`。
2. ゲート定義は MO-02 のゲート語彙(自動検証可能な criteria)を参照する形にし、スキーマ案と 4 テンプレートの草案(YAML/JSON)を本文書末尾に追記して実装に渡す。**AI_DLC_PLAYBOOK の Phase 0-4 を code_change テンプレートの正とする**。

### Task 2: スキーマ実装と 4 テンプレート定義 — `claude-sonnet-4`

1. `schemas/mission-process-template.schema.json` を追加し、テンプレート本体を `knowledge/product/orchestration/mission-process-templates/` に置く(既存テンプレート群の配置規約に従う)。
2. Task 1 の草案どおり 4 テンプレートを定義。残り 5 クラスは当面 `development` 相当の汎用テンプレートに明示マップ(暗黙の潰れではなく、テンプレート側に `applies_to: [...]` を書く)。
3. `check:catalogs`(または新チェック)でスキーマ検証を validate チェーンに追加。

### Task 3: 分類の必須化と mission_type の格下げ — `claude-sonnet-4`

1. `createMission`/`startMission` で `resolveMissionClassification` を必ず実行し、結果(class/shape/risk/stage)を `state.json` に永続化する。呼び出し側が `mission_type` を渡した場合は分類のヒントとして使い、最終的な process template 選択は class から行う。
2. 分類の確信度が低い場合(既存の分類器のシグナル不足時)は `development` 汎用にフォールバックしつつ、`classification_confidence: low` を記録して operator packet に「分類を確認してください」と 1 行出す。
3. 既存ミッション(state に class なし)は読み込み時に lazy 分類する後方互換を入れる。

### Task 4: worker のテンプレート駆動化(最小差分)— `claude-sonnet-4`

1. `mission-orchestration-worker.ts` のイベント連鎖(`:920-951`)を、process template の `phases` 配列を読んで次フェーズを決める形に変える。**この IP ではフェーズ列の差し替えのみ**(ゲート評価は MO-02、並列化は MO-03 で入れる)。テンプレートが無いクラスは現行連鎖と同一の汎用フェーズ列を使い、挙動互換を保つ。
2. 適用テンプレート名を kickoff 時の Slack/Chronos 通知と TASK_BOARD.md ヘッダに表示する。
3. テスト: fixture ミッションで class 別に異なるフェーズ列が選ばれることを unit test で固定。

### Task 5: 検証 — `claude-haiku`

- 代表発話 4 種(コード変更/調査/資料作成/リリース作業)で `mission create` を実行し、分類・テンプレート選択・state 永続化を確認して報告。既存の Slack 起点フロー(モック)で回帰が無いことを確認。

## リスクと注意

- 分類器の precision が低いままテンプレートを強制すると「調査ミッションに SDLC ゲート」のようなミスマッチが起きる。Task 3 の低確信度フォールバック + operator への確認導線を必ず残す。
- チームテンプレートキーとしての `mission_type` に依存する既存データ/テストを grep で洗い、互換マップを一箇所に集約する。
