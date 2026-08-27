---
title: GRAPH ORCHESTRATION PLAN 2026 07 28
tags: [improvement-plan, 2026-07]
last_updated: 2026-07-31
status: archived
---

# グラフオーケストレーション計画 — ループエンジニアリングからグラフエンジニアリングへ(GE-01〜09)

> **作成日**: 2026-07-28
> **優先度**: P1(GE-01/02/03/04/05/06)/ P2(GE-07/08/09)
> **位置づけ**: AR-01(ADF エンジン統一)・HN-03(決定論的オーケストレーション原語)・MO-03(タスク DAG 並列分配)・MO-06(durable resume)の**後続ループ**。前提はすべて DONE または PARTIAL([STATUS](../../improvement-plans-2026-07/STATUS.ja.md))。[ORCHESTRATION_HARNESS_MODEL](../../ORCHESTRATION_HARNESS_MODEL.ja.md) §3/§7 が指摘した「直列 for・バリア同期・workflow-as-code 不在」への構造的回答。
> **実装状況の正本**: [STATUS.ja.md](../../improvement-plans-2026-07/STATUS.ja.md)

## 0. 要旨

業界は「単一エージェントのループを磨く」段階から「複数のノード(エージェント/決定論的ステップ)とエッジ(依存・ルーティング)を宣言されたグラフとして実行する」段階へ移行している(ADK Go 2.0 のグラフワークフローエンジン、LangGraph の durable execution。→ §2)。

kyberion の現状はこの観点で**ねじれて**いる:

```
持っているもの                          使い方
─────────────────────────────────      ─────────────────────────────────
PlannedNextTask.dependencies            wave 同期(Promise.all バリア)で実行
  (検証済み DAG: 循環/欠損検出あり)      → 最遅タスクが wave 全体を止める
task-plan-coordinator の Kahn ソート    直列 for-await で実行(並列度 1)
core:parallel_foreach / parallel_calls  カタログ使用実績 0 件(死蔵)
EventSourcingKernel(journal/replay)    worker goal 状態専用(pipeline 未接続)
work-item claim(リース・排他)          ノード排他の基盤として利用可能なのに
                                        pipeline ステップとは無関係
```

つまり**グラフの「データ」はあるが、グラフの「実行機」がない**。ステップ契約にエッジがなく(配列順のみ)、スケジューラがなく(逐次 for)、チェックポイント再開がない(失敗 = step 0 からやり直し)。

本計画は 3 つの軸で「グラフ実行機」を導入する:

1. **契約**: ステップ間エッジ(制御依存 + データフロー)を pipeline ADF の一級市民にする(GE-01/03)。
2. **実行**: 逐次 for を frontier(ready-set)スケジューラに置き換え、ミッションワーカーの wave バリアを撤廃する(GE-02/05/06)。
3. **耐久性**: ノード境界でのチェックポイントと `--resume` を、既存の EventSourcingKernel の上に構築する(GE-04)。

ガバナンス(GE-07)と観測(GE-08)を同時に伸ばし、wisdom fanout の並列化(GE-09)で dogfood する。**新しい実行エンジンは作らない** — AR-01 で 3 → 1 に統一した `executeAdfSteps` を拡張する。エンジン第 2 系統の再発生は本計画の失敗と定義する。

## 1. 診断(2026-07-28、origin/main `15b3e65e` で実コード突合)

### 1.1 ADF エンジン: エッジなし・逐次のみ

- `libs/core/adf-engine.ts:168` — 実行は `for (const step of steps)` の厳密な逐次ループ。最初の失敗で `break`(`:311`)。
- ステップ契約(`libs/core/pipeline-contract.ts:51-113`、`knowledge/product/schemas/pipeline-adf.schema.json`)に `depends_on`/`next`/`edges` に相当するキーは存在しない。スキーマは step レベルで `additionalProperties: false` のため、エッジ追加は契約変更が必須。
- `produces`/`consumes` はデータフローエッジ**ではない**: `validateFlow`(`scripts/run_pipeline.ts:327-354`)は「配列上で先に produce されたか」の存在検査のみで、並べ替え・並行化の根拠として使われていない。
- 分岐は `core:if` のネスト木のみ(`run_pipeline.ts:1461`)。goto/switch/エッジ条件はない。
- 制御原語の実使用(pipelines/ + pipeline-templates/ を grep): `core:include` 73、`core:if` 40、`core:foreach` 6、`core:transform` 6、`core:while` 1、**`core:parallel_foreach` 0、`core:parallel_calls` 0、`core:accumulate` 0、`core:retry_until_quality` 0**。HN-03 が作った並列/収束原語は死蔵されている。

### 1.2 条件評価の構造的欠陥(グラフルーティングの前提を欠く)

`evaluateCondition`(`libs/core/src/logic-utils.ts:123`)は文字列条件を**コンテキストパス参照**として扱う。式は評価されない:

- `knowledge/product/pipeline-templates/stakeholder-consensus-orchestrator.json:30` の `"condition": "ordered_visits.length > 0"` は `['ordered_visits', 'length > 0']` にトークナイズされ `undefined` → **常に false**。`core:while` は一度も回らず `skipped` になる(潜在バグ、無症状)。
- 構造化形式 `{from, operator, value}` は存在するが、式に見える文字列を検出する lint がなく、黙って偽になる。条件付きエッジ(graph routing)を導入する前に、この評価系を安全化する必要がある。

### 1.3 fan-in にマージポリシーがない

`core:parallel_foreach`(`run_pipeline.ts:1541-1584`)の合流は `{...workingCtx, ...perItemContexts[last]}` — **最後の item のコンテキスト全体が勝つ**。並列結果の集約(collect/namespace/reduce)を宣言する手段がなく、並列原語を実務投入できない主因になっている。失敗は全体 throw のみで部分成功モードもない。

### 1.4 チェックポイント/再開の不在(pipeline 粒度)

- `scripts/run_pipeline.ts` に resume/checkpoint/journal は**ゼロヒット**。失敗した run は step 0 から再実行。
- Trace(`libs/core/src/trace.ts`)は観測用スパンであり、コンテキストスナップショットを持たないため replay 不能。
- 一方で再利用可能な基盤は既にある:
  - `libs/core/worker-state-journal.ts`(756 行)— `EventSourcingKernel`: 純粋 reducer、バージョン付き envelope、migration、restore 中の副作用を構造的に禁止する `assertNotDuringRestore`。**リポジトリ内で最も完成度の高いチェックポイント基盤**だが worker goal 状態専用。
  - `libs/core/mission-orchestration-journal.ts` — `loadMissionOrchestrationReplayPlan()` による L1 イベント粒度の durable resume(MO-06)。pipeline ステップ粒度には未接続。

### 1.5 ミッションワーカー: DAG を持ちながら wave 同期

- `libs/core/mission-orchestration-worker.ts:4726-4978` — dispatch ループは ready タスクを最大 `max_parallel_members`(既定 3)束ねて **`Promise.all`(`:4949`)で全員待ち**。wave 内の最遅タスクが完了するまで、新たに ready になったタスクを開始できない。[ORCHESTRATION_HARNESS_MODEL](../../ORCHESTRATION_HARNESS_MODEL.ja.md) §3 が名指しした anti-pattern そのもの。
- `PlannedNextTask.dependencies` は重複/欠損/循環(DFS)検証済み(`mission-orchestration-worker.ts:580-610`)— **契約は既にグラフ**。
- `libs/actuators/orchestrator-actuator/src/task-plan-coordinator.ts:20-58` は Kahn のトポロジカルソートを実装済みだが、実行(`:181`)は直列 for-await。
- L1(イベントチェーン)の followup↔reconciliation ループバック(`:5892-5955`)には反復上限がなく、収束はコメント上の単調減少論証のみ。L3 の再作業上限はマジックナンバー(acceptance rework `< 1`、review round `>= 2`)。

### 1.6 delegateTask にノード同一性がない

- `ReasoningBackend.delegateTask`(`libs/core/reasoning-backend.ts:470-560`)は `(instruction, context?, options?) => Promise<string>`。**タスク ID なし・状態なし・join/cancel なし**。構造は返答テキストの JSON 再パースで復元している(`parseTaskResultResponse`)。
- 最も近い既存物は `DelegatedTaskRecord.delegation_id`(`libs/core/delegated-task-observability.ts`)だが観測専用。グラフランタイムがノードとして委譲を扱うには、アドレス可能なハンドルが必要。

### 1.7 guardrails のグラフ盲点

`adf-guardrails.ts:240-301` のトラバースは `core:parallel_calls.params.calls` を辿らず、`core:include` フラグメント(実行時解決)を見られない — **step 予算と lint が回避可能**。グラフ化で入れ子が増える前に塞ぐ必要がある。

### 1.8 wisdom fanout: 最も並列化しやすい処理が直列

`wisdom:perspective_fanout`(`libs/actuators/wisdom-actuator/src/decision-ops.ts:446`)は participants を直列 for で回し、`simulate_all_ensemble`(`:789-913`)は N 回の逐次実行。fan-out という名前の逐次処理であり、GE-02 の最初の dogfood 対象として最適。

## 2. 外部動向(2026-07 時点)と設計原則

**動向**(詳細ソースは章末):

- **ADK Go 2.0**(2026-06-30 リリース)がグラフベースのワークフローエンジンを導入。ADK 1.x 系の SequentialAgent / ParallelAgent / LoopAgent(ワークフローエージェント合成)から、グラフ第一の実行モデルへ移行した。
- **LangGraph** は checkpointer によるステップ(superstep)境界の状態保存を土台に、障害からの再開・履歴・human-in-the-loop を実現(durable execution)。ただし「チェックポイントはノード**間**の状態のみ保存し、ノード内部は保存しない」ことが知られており、ノード境界の設計が本質。
- 2026-07 の言説では「ループ = グラフの 1 ノード」「グラフ = 事前に宣言された構造 = **システムが行ってよいことの仕様**」という整理が定着しつつある。宣言された構造は検証・ガバナンス・監査の対象にできる — これは kyberion の preflight/guardrails 思想と完全に同型。

**kyberion 設計原則**(本計画の全項目を拘束):

1. **グラフは宣言であり、ガバナンス対象である。** エッジは実行前に検証される(循環・未定義参照・到達不能・非マージ fan-in)。動的なグラフ書き換えは導入しない — 動的判断はノードの中(LLM 判断ステップ)で行い、構造は静的に保つ。
2. **エンジンは 1 つ。** AR-01 で統一した `executeAdfSteps` を拡張する。graph-engine.ts のような並行実装を新設しない。エッジ未宣言の既存 pipeline は「線形チェーン」という縮退グラフとして**無変更で**動き続ける。
3. **ループはノードである。** `core:while`/`loop_until`/`retry_until_quality` は廃止せず、グラフの 1 ノードに包含される(ADK の LoopAgent と同型)。ループエンジニアリングの資産は破棄しない。
4. **チェックポイントはノード境界。** ノード内部の再開は狙わない(LangGraph の教訓)。ノード出力(produces チャネル)のスナップショットが再開単位。
5. **外部フレームワークは採用しない。** LangGraph/Temporal/ADK への依存は hermetic テスト・決定論・secure-io 不変条件と両立しないため非採用。概念のみ取り込み、実装は既存カーネル(EventSourcingKernel、work-item claim、tool-call-scheduler)の再利用で行う。
6. **スケジューラは資源宣言を尊重する。** 並行実行は `ResourceClaim`(KD-07)と `delegation-concurrency`(XP-06)の既存ガバナンスの**下で**行う。グラフ化は並行度の上限を緩めない。

## 3. 目標アーキテクチャ

```
宣言層   pipeline ADF(steps + edges)          ← GE-01/03: depends_on・データエッジ・when
           │ preflight: スキーマ + guardrails + グラフ検証(循環/到達性/fan-in)← GE-07
検証層     │
実行層   frontier スケジューラ(executeAdfSteps 内)← GE-02
           │  ready-set 駆動・完了駆動(バリアなし)
           │  並行度 = ResourceClaim ∩ delegation-concurrency
           │  fan-in = 宣言されたマージポリシー(collect/namespace/reduce)
           ├─ ノード種: 決定論 op / LLM 判断 op / ループノード / 委譲ノード(GE-06 ハンドル)
耐久層   run journal(EventSourcingKernel 派生)  ← GE-04
           │  node_completed イベント + チャネルスナップショット → --resume <run_id>
観測層   DAG 形 trace(mission-run ルートスパン + run-graph アーティファクト)← GE-08
利用層   ミッションワーカー(wave バリア撤廃)← GE-05 / wisdom fanout 並列化 ← GE-09
```

コミットメント:

1. エッジ未宣言 pipeline の実行結果はバイト等価(後方互換 100%)。
2. グラフ実行はスケジュール順が非決定でも、**結果とジャーナルは決定論的に検証可能**(ノード完了イベントの半順序 + 各ノード出力ハッシュ)。
3. ミッションワーカーと pipeline エンジンのスケジューラ核は同一ライブラリ(`libs/core/graph-scheduler.ts`)を共有する。

## 4. 実装タスク

### GE-01: ステップ間エッジの契約化(depends_on + データフローエッジ)

> 優先度 P1 / 規模 M / 依存: なし

`PipelineAdfStep` に `depends_on?: string[]`(step `id` 参照の制御エッジ)を追加し、`pipeline-adf.schema.json` / `pipeline-contract.ts` / AJV 検証を同時更新する。`produces`/`consumes` を正式なデータフローエッジに昇格: `validateFlow` を「配列順の存在検査」から「エッジ導出 + 循環/欠損検証」に置き換える(導出エッジと `depends_on` の合成が実効グラフ)。検証は preflight で fail-closed: 循環(既存の PlannedNextTask 用 DFS を共通化)、未定義 `id` 参照、`depends_on` があるのに `id` がないステップ。エッジ宣言の有無が混在する pipeline は、未宣言ステップを「直前ステップへの暗黙エッジ」として解釈し、既存カタログ全 pipeline が無変更で valid であることをスナップショットで固定する。

**受入条件**

1. エッジ未宣言の既存カタログ pipeline 全件が preflight を通過し、実行結果が変更前とバイト等価(golden 回帰)。
2. 循環・未定義参照・id 欠落の 3 種が preflight で fail-closed になる hermetic テスト。
3. `depends_on` + `produces`/`consumes` から実効グラフ(nodes/edges JSON)を導出する純関数が単体テストで固定される。

— claude-sonnet-4

### GE-02: frontier スケジューラ(逐次 for の置換)

> 優先度 P1 / 規模 L / 依存: GE-01

`libs/core/graph-scheduler.ts` を新設(純粋な ready-set 計算 + 完了駆動の frontier 前進。I/O なし・注入されたノード実行関数を呼ぶだけ)し、`executeAdfSteps` をその上に載せ替える。エッジ未宣言(線形チェーン)の場合は従来と同一の逐次挙動に厳密に縮退する。並行実行は (a) `ResourceClaim` の衝突検査(`tool-call-scheduler.ts` を流用)、(b) `delegation-concurrency` の slot、(c) pipeline `options.max_concurrency`(既定 1 = 完全互換)の 3 制約の交差で決める。fan-in はマージポリシーを契約化: `merge: 'collect'(既定: 配列に集約)| 'namespace'(step id 下に格納)| 'last'(現行互換・明示時のみ)`。`core:parallel_foreach` の last-wins 合流(診断 1.3)を `collect` 既定に修正し、部分失敗モード(`on_item_error: skip|abort`)を追加する。ループノード(`core:while` 系)はスケジューラから見て単一ノード(原則 3)。

**受入条件**

1. `max_concurrency: 1` かつエッジ未宣言で、全カタログ pipeline の実行順・結果が現行と一致(golden 回帰)。
2. ダイヤモンド型(fan-out 2 → fan-in)の hermetic テストで、遅いノードが速い側の下流を妨げないこと(完了駆動)と、`collect`/`namespace` マージの両方を検証。
3. ResourceClaim が衝突する 2 ノードが同時実行されないことをスケジューラ単体テストで固定。
4. `core:parallel_foreach` の合流が `collect` になり、部分失敗 `skip` で残 item が完走する回帰テスト。

— 設計 claude-opus / 実装 claude-sonnet-4

### GE-03: 条件付きエッジと安全な式評価

> 優先度 P1 / 規模 M / 依存: GE-01(GE-02 と併走可)

エッジに `when`(構造化条件 `{from, operator, value}`)を追加し、偽の場合は下流を `skipped` 伝播させる(ミッションワーカーの `cascadeBlockedDependents` と同型の fixpoint)。排他分岐は `core:switch`(case 配列 + default)を追加して `core:if` ネスト木を平坦化可能にする。診断 1.2 の欠陥を根治: `evaluateCondition` に「文字列条件が演算子様のトークン(`>`、`<`、`==`、`&&`、`.length` 等)を含む場合は fail-closed でエラー」を追加し(黙って false を廃止)、guardrail lint `condition-looks-like-expression` を新設。`stakeholder-consensus-orchestrator.json:30` を構造化条件へ修正する。式言語の新設はしない(構造化条件で表現できない判断は LLM 判断ノードか typed op へ — LAYERED_EXECUTION の層規律)。

**受入条件**

1. `"a.length > 0"` 型の文字列条件が preflight/実行の双方でエラーになる回帰テスト(現行の黙殺 false が再現不能になる)。
2. `when` エッジ偽 → 下流 `skipped` 伝播、`core:switch` の case/default 選択の hermetic テスト。
3. stakeholder-consensus-orchestrator が修正後に while 本体を実行することをスタブ backend で検証。

— claude-sonnet-4

### GE-04: ノード境界チェックポイントと --resume(durable execution)

> 優先度 P1 / 規模 L / 依存: GE-01・GE-02

`EventSourcingKernel`(`worker-state-journal.ts`)のモデル定義機構を使い、pipeline run journal を新設: `run_started` / `node_completed {step_id, output_channels_snapshot, output_hash}` / `node_failed` / `run_finished` をミッション配下(`<missionDir>/coordination/pipeline-runs/<run_id>.jsonl`、ミッション外は `active/shared/runtime/pipeline-runs/`)へ追記。`run_pipeline --resume <run_id>` は journal を restore し、完了ノードの出力チャネルをコンテキストへ再注入して frontier を未完了ノードから再開する。副作用ノードの二重実行を防ぐため、restore 中の実行は `assertNotDuringRestore` の流儀で構造的に禁止。決定論(cross-platform determinism 実践)のため、スナップショットは `produces` チャネル値のみ(コンテキスト全体は保存しない — 原則 4)。Trace は従来どおり観測専用のまま(journal が replay の正本)。

**受入条件**

1. 5 ノード pipeline を 3 ノード目で人為的に失敗させ、`--resume` で残り 2 ノードのみ実行され最終結果が一発成功時と一致する hermetic テスト。
2. resume 時に完了済みノードの op ハンドラが**呼ばれない**こと(スパイで固定)。
3. journal スキーマは versioned envelope + migration を備え、壊れた journal は fail-closed で resume 拒否(黙って step 0 からやり直さない)。

— 設計 claude-opus / 実装 claude-sonnet-4

### GE-05: ミッションワーカーの wave バリア撤廃

> 優先度 P1 / 規模 L / 依存: GE-02・GE-06

`dispatchMissionNextTasks`(`mission-orchestration-worker.ts:4726`)の `Promise.all` wave ループを `graph-scheduler.ts` の frontier 駆動に置換する。ノード = `PlannedNextTask`、エッジ = `dependencies`、並行度上限 = `max_parallel_members`(現行値維持)、ノード実行 = 既存 `dispatchPlannedMissionTask`(変更しない)。タスク完了ごとに ready 集合を再計算して即時 dispatch(完了駆動)。`cascadeBlockedDependents` はスケジューラの `skipped/blocked` 伝播へ統合。あわせてループ上限をポリシー化: L1 followup↔reconciliation に反復上限(`mission-workflow-catalog` の team_governance 由来、既定 20、超過で ops-alert + paused)、L3 のマジックナンバー(rework `< 1`・review round `>= 2`)を同じポリシー面へ移す(既定値は現行と同一 — 挙動不変でパラメタ化のみ)。

**受入条件**

1. 依存 A→C、B→C で A が B の 3 倍遅いシナリオ(スタブ backend)で、B 完了直後に B の独立下流が開始されること(wave 版では不可能なスケジュール)を hermetic テストで固定。
2. 既存のミッションオーケストレーション統合テスト(MO-03/MO-07 系)が全緑のまま。dispatch 順の決定性が要るテストは完了イベントの半順序検証へ移行。
3. L1 反復上限超過で ops-alert + mission paused になる回帰テスト。既定ポリシー値での挙動は現行と一致。

— 設計 claude-opus / 実装 claude-sonnet-4

### GE-06: 委譲ノードの同一性(delegateTask ハンドル API)

> 優先度 P1 / 規模 M / 依存: なし(GE-05 の前提。GE-01/02 と併走可)

`ReasoningBackend` に `delegateTaskHandle(instruction, context?, options?): DelegationHandle` を追加する(既存 `delegateTask` は互換維持し、内部で handle 版に委譲)。`DelegationHandle = { delegation_id, status(), join(): Promise<TaskResultBlock | string>, cancel(reason): Promise<void> }`。`delegation_id` は `DelegatedTaskRecord` と同一 ID 空間を使い、観測レコードを「事後記録」から「join 可能な実体」へ昇格する(`delegated-task-observability.ts` に status 遷移の書き込み手を一本化)。cancel は `delegation-concurrency` の SIGTERM→SIGKILL 経路を再利用。FailoverReasoningBackend / 各 CLI backend への実装は「1 件目 sonnet でパターン確立 → 残り backend は haiku 横展開」。

**受入条件**

1. handle の `join()` が既存 `delegateTask` と同一の文字列/構造化結果を返す互換テスト(全 backend、stub 含む)。
2. `cancel()` 後に status が terminal になり、`DelegatedTaskRecord` に cancel 事由が記録される hermetic テスト。
3. 既存 `delegateTask` 呼び出し箇所のコード変更ゼロ(grep で確認、変更があれば計画違反)。

— claude-sonnet-4(backend 横展開は claude-haiku)

### GE-07: グラフ guardrails とプレビュー

> 優先度 P2 / 規模 S〜M / 依存: GE-01

診断 1.7 の盲点を塞ぐ: guardrails のトラバースに `core:parallel_calls.params.calls` を追加し、`core:include` は preflight 時にフラグメントを解決して展開後グラフに lint を適用する(実行時解決との二重化を避けるため resolver を共通化)。グラフ lint を新設: `graph-unreachable-node`、`graph-unmerged-fanin`(fan-in にマージポリシー未宣言)、`graph-loop-without-bound`(`max_iterations` 欠落)、`condition-looks-like-expression`(GE-03)。`pipeline-preview.ts` に実効グラフの Mermaid 出力(`--preview-graph`)を追加し、pipeline カタログ README の生成儀式に組み込む。

**受入条件**

1. `parallel_calls` 内・`include` フラグメント内のステップ予算超過が preflight で検出される回帰テスト(現行はすり抜けることを先に赤テストで実証)。
2. 4 種のグラフ lint がそれぞれ最小再現 pipeline で発火する hermetic テスト。
3. 代表 pipeline 3 件の Mermaid 出力が golden スナップショットで固定される。

— claude-sonnet-4(lint 横展開は claude-haiku)

### GE-08: DAG 形トレースと run-graph アーティファクト

> 優先度 P2 / 規模 M / 依存: GE-02(GE-04 と併走可)

mission-run ルートスパンを導入し、現在バラバラに永続化される `mission_task_dispatch` スパン(診断: per-task で flat)を correlation_id で束ねる。グラフ実行の終了時に run-graph アーティファクト `{nodes: [{id, status, duration_ms, output_hash}], edges: [{from, to, kind: control|data|when}]}` を trace metadata と併置し、`agent-collaboration-projection.ts`(既存の nodes/edges 可視化投影)へ接続して chronos で「どのノードがどこで止まったか」を見られるようにする。UX-07(エージェント協調可視化)の観測基盤と重複させず、投影の入力を増やす形で実装する。

**受入条件**

1. グラフ実行 1 回につき run-graph アーティファクトが 1 件生成され、ノード状態が journal(GE-04 導入済みなら)/実行結果と一致する hermetic テスト。
2. `agent-collaboration-projection` が run-graph を取り込み nodes/edges を返す単体テスト。
3. trace スパン数・イベント名の既存 golden が非グラフ実行で不変。

— claude-sonnet-4

### GE-09: wisdom fanout の並列化(dogfood)

> 優先度 P2 / 規模 S〜M / 依存: GE-02

`wisdom:perspective_fanout` の直列 for(`decision-ops.ts:446`)を graph-scheduler の fan-out/collect に置換(participant ごとの context pack 構築・egress guard・receipt 永続化は現行ロジックを 1 ノード = 1 participant として維持)。`simulate_all_ensemble` の N 回逐次実行も同様に並列化し、収束判定(`evaluateEnsembleConvergence`)は fan-in の collect 後に不変のまま適用。並行度は tenant budget / RATE_LIMITED_OPS の既存制約下(原則 6)。これが GE-02 の最初の実運用 dogfood であり、所要時間の before/after を STATUS へ記録する。

**受入条件**

1. スタブ backend で fanout 結果(receipt 集合・集約出力)が直列版と順序を除き一致する回帰テスト。
2. 1 participant の失敗が他 participant を巻き込まない部分失敗テスト(現行は全体失敗)。
3. 実 backend での 3-persona fanout の壁時計時間が直列版比で短縮されることを 1 回実測し、STATUS の残作業欄へ記録。

— claude-sonnet-4

## 5. 実施順序

```
GE-01(エッジ契約)─┬─ GE-02(frontier スケジューラ)─┬─ GE-03(条件付きエッジ・式評価)
                    │                                ├─ GE-04(checkpoint / --resume)
                    │                                ├─ GE-08(DAG トレース)
                    │                                └─ GE-09(wisdom 並列化・dogfood)
                    └─ GE-07(グラフ guardrails・プレビュー)

GE-06(delegation ハンドル)──┐
GE-02 ──────────────────────┴─ GE-05(ミッションワーカー wave 撤廃)
```

推奨 wave: **W1** GE-01・GE-06(独立・併走可)→ **W2** GE-02・GE-07 → **W3** GE-03・GE-04・GE-09 → **W4** GE-05・GE-08。GE-05 は挙動変更の影響面が最大のため、GE-09 の dogfood で スケジューラ核を実戦検証してから着手する。

## 6. 非目標

- **外部グラフフレームワーク(LangGraph/Temporal/ADK)の依存追加**(原則 5)。
- **実行時の動的グラフ書き換え**(ノード内 LLM 判断で代替。構造は宣言時に固定 — 原則 1)。
- **3 つのタスク表現(PlannedNextTask / WorkItem / ticket)の統合** — MO-03 で明示的に繰り延べられた課題であり、本計画は PlannedNextTask をノードとして扱うに留める。統合は別計画。
- **L1 イベントチェーン(process-per-step)のグラフ化** — MO-06 の journal で耐久性は担保済み。プロセス粒度の再設計はスコープ外。
- **1 ミッション 1 オーナー原則・work-item claim 排他の変更**(SO/XP の領分。グラフ並列はワーカー並列であり、書き込み権は従来どおり claim 保持者のみ)。
- **`core:transform` の式言語化**(JS-in-string の拡大は LAYERED_EXECUTION の層規律に反する)。

## 7. 関連計画

- [AR-01_UNIFY_ADF_ENGINE](./AR-01_UNIFY_ADF_ENGINE.ja.md) — エンジン 3→1 統一(DONE)。本計画の「エンジンは 1 つ」原則の前提。
- [HN-03_DETERMINISTIC_ORCHESTRATION](./HN-03_DETERMINISTIC_ORCHESTRATION.ja.md) — 並列/収束原語の導入(DONE)。GE-02 が死蔵状態を解消する。
- [MO-03_TASK_DAG_PARALLEL_DISPATCH](./MO-03_TASK_DAG_PARALLEL_DISPATCH.ja.md) — wave 並列分配(DONE)。GE-05 が wave → frontier へ進める。
- [MO-06_DURABLE_RESUME](./MO-06_DURABLE_RESUME.ja.md) — L1 イベント journal(DONE)。GE-04 が pipeline ステップ粒度へ拡張。
- [LAYERED_EXECUTION_PLAN_2026-07-15](./LAYERED_EXECUTION_PLAN_2026-07-15.ja.md) — 層規律。GE-03/非目標の根拠。
- [UX-07_AGENT_COLLABORATION_VISIBILITY](../../improvement-plans-2026-07/UX-07_AGENT_COLLABORATION_VISIBILITY.ja.md) — 協調可視化。GE-08 の接続先。
- [WISDOM_AGENT_OWNERSHIP_2026-07-20](./WISDOM_AGENT_OWNERSHIP_2026-07-20.ja.md) — orchestrator actuator への ops 移管。GE-09 と整合。
- [ORCHESTRATION_HARNESS_MODEL](../../ORCHESTRATION_HARNESS_MODEL.ja.md) — 直列 for / バリアの anti-pattern 指摘(§3)と workflow-as-code 不在(§7)。

---

**外部ソース**(§2 の根拠、2026-07-28 閲覧):

- [Google ADK Go 2.0 のグラフワークフロー](https://qatechtools.com/2026/07/03/google-adk-go-2-0-qa-agent-workflows/) / [ADK ワークフローエージェント解説](https://medium.com/@shins777/adk-workflow-the-core-logic-of-ai-agent-8ce4be5c1c40) / [ADK graph routes](https://adk.dev/graphs/routes/)
- [LangGraph durable execution](https://vadim.blog/durable-execution-agents-that-survive-failure-and-resume-where-they-left-off) / [checkpoint はノード間のみ — durable execution との差分](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)
- [From Loops to Graphs: The 2026 AI Agent Architecture Shift](https://noqta.tn/en/blog/ai-agents-loops-to-graphs-architecture-shift-2026) / [Graph Engineering vs Loop Engineering](https://www.aibuilderclub.com/blog/graph-engineering-vs-loop-engineering) / [Graph Engineering Guide 2026](https://www.aibuilderclub.com/blog/graph-engineering-guide-2026)
