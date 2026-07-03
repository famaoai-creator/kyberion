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
