# HN-03: 決定論オーケストレーションの強化 — 並列・loop-until・workflow-as-code・無音打ち切りの解消

> 優先度: P1 / 規模: L(フェーズ分割) / 依存: MO-03(DAG 分配) / 関連: [ORCHESTRATION_HARNESS_MODEL](../ORCHESTRATION_HARNESS_MODEL.ja.md) §3/§5/§7、MO-06(レジューム)
>
> **参考にしたハーネス原則(Fable 5)**: 決定論的な制御フロー(ループ・条件・fan-out)はコードで、モデル判断はプロンプトで。既定はアイテム独立パイプライン、バリアは横断参照の時だけ。未知サイズの発見は loop-until-dry、低品質は retry-until-quality。**削ったものは必ず log する(無音打ち切り禁止)。** MO-03 が「ミッションのタスク並列化」なら、HN-03 は「パイプライン言語(ADF)と実行系そのものにこれらの制御能力を与える」層。

## 背景と課題

Kyberion の決定論基盤(ADF パイプライン)は制御フローが弱く、無音打ち切りが常態。

- **並列/map op が無い**: `run_pipeline.ts` の `core:foreach`(`:450-465`)は list を**逐次**反復(`for (const item of items)`、失敗で break)。`Promise.all` も並列度指定も無い。system-actuator の `while`(`:290-299`)は別実行系にあり foreach と分離(HN 確認 §3)。
- **loop-until / retry-until-quality が無い**: `foreach` は既知 list の bounded 反復のみ。条件到達までのループ、品質未達での再試行、目標到達までの累積が言語に無い(HN 確認 §6)。
- **workflow-as-code の経路が無い**: 決定論オーケストレーションは JSON ADF のみ。「決定論骨格 + 判断ノード」を imperative に author する手段が無く、唯一の脱出は `core:transform` の vm 実行(`:506-525`)。
- **effort/予算がハーネス制御になっていない**: effort は adaptive 固定(HN 確認 §4)、予算はプロンプト注入のみ(OP-01)。
- **無音打ち切りが常態**: top-N・maxQuestions・sampling・history cap のほぼ全てが silent slice(`intent-contract.ts:363`、`presentation-preference-profile.ts:45`、`surface-runtime-orchestrator.ts:493`、`sample_traces` のランダム抽出 等)。ハード安全上限(MAX_STEPS/loop guard)のみログ(HN 確認 §7)。

## ゴール(受入条件)

1. ADF パイプラインに **並列 map op**(`core:parallel_foreach` 等、並列度キャップ付き)が入り、依存の無いアイテムを同時実行できる。バリアが必要な段は明示。
2. **loop-until / retry-until-quality / accumulate-to-target** 制御が言語に入る(条件到達・品質未達再試行・目標累積、いずれも上限付き)。
3. **workflow-as-code の第一級経路**: 決定論骨格 + 判断ノードを TS で author し実行できる(または既存の pipelines/ を「制御フロー付き」に拡張)。判断ノードだけがモデルを呼ぶ。
4. **無音打ち切りの解消**: top-N/sampling/cap で削ったら、落とした件数を log + 可能なら成果物メタに添付する規律(と lint)を入れる。
5. **effort/予算のハーネス制御**: パイプラインステップに effort ヒント(HN-01)と予算(OP-01)を宣言でき、超過で止める/承認要求。

## 実装タスク

### Task 1: 並列 map op — `claude-sonnet-4`

1. `run_pipeline.ts` に `core:parallel_foreach`(list を並列度キャップ付きで並列実行、各アイテムは独立、結果を集約)を追加。既存 `core:foreach` は逐次のまま残す(明示選択)。同一 target への書き込み競合は直列化(MO-03 の規約と共有)。
2. バリアの明示: 並列結果を全件揃えてから次段へ進む段と、アイテム独立で流す段を区別できる構文にする(既定はパイプライン、バリアは opt-in)。
3. provider レート制限に配慮(並列度既定は控えめ、エラー時バックオフ)。テスト: 並列実行・順序非依存・競合直列化。

### Task 2: loop-until / retry-until-quality / accumulate — `claude-sonnet-4`

1. `core:loop_until`(条件到達まで、max_iterations 必須)、`core:retry_until_quality`(MO-07 の品質ルーブリック verdict が ok になるまで/上限まで、poor で HN-01 の tier escalation)、`core:accumulate`(目標件数まで finder を回す、loop-until-dry の K 回連続ゼロ判定)を追加。
2. すべて上限付き(無限ループ禁止)。収束判定は「seen 集合」に対して行う(承認済みでなく)。
3. テスト: 各制御の到達/上限/収束。

### Task 3: workflow-as-code の経路 — `claude-opus`(設計)→ `claude-sonnet-4`(実装)

1. 設計(opus): 「決定論骨格 + 判断ノード」を安全に author する方式を決める。案 A: `core:transform` の vm を拡張し、制御フロー + `delegate` 呼び出しを書ける限定 DSL にする。案 B: pipelines/ を TS モジュールとして書ける経路(sandbox 実行)を足す。**セキュリティ(SA-02 のシェル/実行ガードレール)との整合を最優先**に案を選び、本文書末尾に設計を追記。
2. 実装(sonnet): 選定案を実装。判断ノードのみがモデル(HN-02 の schema-forced delegate)を呼び、制御フローは決定論。ジャーナル(MO-06)で決定論レジューム可能に。
3. テスト: 制御フロー + 判断ノードの混在ワークフローが再現可能に実行・レジュームできること。

### Task 4: 無音打ち切りの解消 — `claude-haiku`

1. silent slice のホットスポット(`intent-contract.ts:363`、`presentation-preference-profile.ts:45`、`surface-runtime-orchestrator.ts:493`、`surface-query-helpers.ts:74`、`sample_traces` 等)に「落とした件数の log + 成果物メタへの `omitted_count` 添付」を入れる。
2. `eslint` の `no-restricted-syntax` 等で「`.slice(0, N)` の直後にログ/注記が無いデータ切り詰め」を warn 化できるか検討(過剰なら文書規約 + レビュー観点に留める)。
3. テスト: 代表箇所で omitted_count が出ること。

### Task 5: effort/予算のステップ宣言 — `claude-sonnet-4`

1. ADF ステップに `effort`(HN-01)と `budget`(OP-01)を宣言できるスキーマ拡張。実行時に effort を backend へ伝搬、予算超過で停止/承認要求(OP-01 の spend-guard 連携)。
2. テスト: effort 伝搬、予算超過停止。

## リスクと注意

- **workflow-as-code は実行の安全性が最大の論点**。任意コード実行は SA-02(シェル/ADF ガードレール)の脅威モデルに直結する。Task 3 は SA-02 の完了後 or 密連携で行い、判断ノード以外は決定論(副作用は既存 actuator 経由・tier-guard 下)に限定する。vm 拡張は sandbox 境界を慎重に。
- 並列化は provider レート制限・コスト・書き込み競合を顕在化させる。並列度既定を控えめにし、MO-03 の競合直列化と OP-01 の予算連携を共有する。
- loop-until/accumulate は暴走コストの温床。上限必須 + 予算連携 + 各ラウンドの log を厳守。
- 無音打ち切りの解消は広範な小変更。ホットスポットから着手し、lint 化は過剰にならない範囲で(まず log 追加を優先)。

## 実装メモ

### Task 1 / 2 / 4 / 5 slice — 2026-07-04

- `scripts/run_pipeline.ts` / `scripts/run_pipeline.js` に `core:accumulate` を追加し、`items` を seen 集合で追跡しながら `target_count` と `dry_streak_limit` で打ち切る実装にした。`core:parallel_foreach` と `core:retry_until_quality` の分岐もそのまま壊さないように維持した。
- `libs/core/adf-guardrails.ts` と `libs/core/src/pipeline-preview.ts` / `.js` に `accumulate` を認識させ、ガードレール検査と preview 表示で子ステップを追えるようにした。
- `scripts/demos/workflow-as-code-example.ts` は parallel / accumulate / effort / budget の例を載せるデモに更新し、`scripts/refactor/adf-input.test.ts` で検証対象に含めた。
- `scripts/run_pipeline.ts` / `scripts/run_pipeline.js` は `.ts/.js/.mjs/.cjs` の workflow module を直接読む入口になり、JSON ADF と同じ検証・実行系に乗るようにした。
- `libs/core/question-resolver.ts` は省略された明確化質問数を `logger.info` で記録し、`libs/core/question-resolver.test.ts` でログ発火を固定した。
- `scripts/run_pipeline.test.ts` で `accumulate` と `retry_until_quality` の到達条件を固定し、実行系の回帰を防ぐようにした。

### Task 3 slice — 2026-07-05

- `scripts/run_pipeline.test.ts` に workflow-as-code の実行回帰を追加し、`scripts/demos/workflow-as-code-example.ts` を `readValidatedWorkflowAdf()` で読んだあと、そのまま `runSteps()` で最後まで流せることを固定した。`core:transform` / `core:parallel_foreach` / `core:accumulate` が TS module 経路でも同じ実行系に乗ることを確認済み。
- `scripts/run_pipeline.ts` の workflow module 入力経路は `.ts/.js/.mjs/.cjs` を `pathToFileURL()` 経由で読み、JSON ADF と同じ guardrail + schema 検証を通してから実行する。判断ノードだけが reasoning backend を呼び、制御フローは deterministic のまま維持される。

### Typed Flow fail-fast slice — 2026-07-11

- `runValidatedSteps` を JSON ADF / workflow module の共通実行入口とし、欠損 channel があれば `runSteps` を開始せず `flow:validate` failure を返す。
- validation failure は `pipeline.validation_failed` として trace に残し、壊れた契約の一部実行と副作用を防止する。
