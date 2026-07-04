# IL-01: ゴールの貫通 — 受信時に合意したゴールを実行まで運ぶ

> 優先度: **P0** / 規模: M / 依存: なし / 関連: MO-01(mission type)とは層が別。MO はミッション内部機構、IL は「元の user intent の goal を縦に貫く」縫い目。
>
> **なぜ重要か**: INTENT_LOOP_CONCEPT の中核は「intent → goal → result の一貫性」。その goal が実行の入口で捨てられているため、以降の検証・完了・学習すべてが「本来の依頼」ではなく汎用プレースホルダに対して行われている。この 1 本の seam が下流の複数ギャップ(IL-03/IL-04)の根本原因。

## 背景と課題

受信時に intent は豊かな goal(`IntentContract.goal { summary, success_condition }`、`intent-contract.ts:84`)まで解釈されるのに、**ミッション昇格の seam でそれが捨てられる**。

- サーフェスがミッションに昇格するとき、`handleGovernedExecutionHint` は `mission_controller.js create <id> public` に **mission-id・tier・任意の `--routing-decision` しか渡さない**(`surface-runtime-orchestrator.ts:1056-1068,1119-1130`)。元の発話も `compiledFlow.intentContract.goal` も `outcome_ids` も渡さない。
- `mission_controller create` は `visionRef` を受け取れる(`scripts/mission_controller.ts:334`)のに、サーフェスは供給しない。
- 結果、ミッションは**汎用の outcome contract を再生成**する: `requested_result = "Complete mission scope for type ${missionType}"`、`success_criteria = ["Mission lifecycle reaches completed with verification and distillation."]`(`libs/core/outcome-contract.ts:88-105`)。受信時の本物の goal は消え、ミッションの「ゴール」はプロセスの空文になる。

## ゴール(受入条件)

1. サーフェス→ミッション昇格時に、(a) 元の発話 `source_text`、(b) `IntentContract.goal`(summary + success_condition)、(c) `outcome_ids` がミッション作成に渡り、`outcome_contract.requested_result` が**実際のユーザーの依頼**になる(`"Complete mission scope for type development"` の廃止)。
2. task_session・pipeline 経路でも同様に、解釈済み goal が実行コンテキストに保持される。
3. ミッション状態(`state.json`)から「元の発話・合意ゴール」が参照でき、UX-02 の進捗表示や IL-04 の完了突合が参照できる。
4. goal が供給されなかった場合のみ現行の汎用フォールバックが働く(後方互換)。

## 実装タスク

### Task 1: goal 供給の配線 — `claude-sonnet-4`

1. `handleGovernedExecutionHint`(`surface-runtime-orchestrator.ts:933` 以降、create 呼び出しは `:1052-1068`)を、`mission_controller create` に `--vision-ref`(または新設の `--intent-goal` JSON)で `source_text` + goal + outcome_ids を渡すよう変更する。既存の `visionRef` 受け口(`mission_controller.ts:334`)を優先的に使い、必要なら goal 専用フィールドを足す。
2. 引数が長大/多構造になるため、一時ファイル(`active/shared/tmp/` の intent-handoff JSON)経由で渡し、パスを引数にする方式を検討(shell 引数長・エスケープ回避)。IP-05 の CLI 規約と整合。
3. テスト: サーフェス昇格 → mission state の outcome_contract に実発話が入ることを E2E(stub backend)で確認。

### Task 2: outcome contract 生成の goal 優先化 — `claude-sonnet-4`

1. `outcome-contract.ts:88-105` の生成を「渡された intent goal があればそれを `requested_result`/`success_criteria` の基礎にし、無ければ現行の汎用文」に変更する。success_criteria は goal.success_condition を分解して具体化(IL-04 の完了突合が検証可能な粒度に)。
2. `evidence_required` の既定(現状 `false`、`:83`)を、goal が成果物を含意する場合は `true` に寄せる(IL-04 と連動。ただし挙動変更は慎重に、まず goal 由来のもののみ)。
3. テスト: goal ありでの contract 生成、goal なしフォールバック。

### Task 3: task_session / pipeline 経路の goal 保持 — `claude-sonnet-4`

1. `handleTaskSessionRoute`(`:214`)と pipeline 経路で、compiled goal を task-session の outcome contract / 実行コンテキストに保持する(ミッションと同じ構造で)。
2. これにより軽量パスでも「何を達成すべきか」が構造として残り、IL-04 の close-the-loop が全 shape で可能になる。
3. テスト: task_session の outcome contract に goal が入ること。

### Task 4: 検証 — `claude-haiku`

- 代表発話(「来週の SBI 向け提案資料を作って」等)で受信 → 昇格 → mission state を確認し、`requested_result` が汎用文でなく実依頼になっていることを確認して報告。goal 未供給時のフォールバックも確認。

## リスクと注意

- goal を渡す経路(shell 引数 or 一時ファイル)は confidential 発話を含み得る。一時ファイルは tier-guard 保護下(`active/shared/tmp/` でなくミッション tier に応じた場所)に置き、処理後に確実に削除する。
- outcome contract の `requested_result` 変更は、それを読む既存の完了判定・表示に波及する。まず「実 goal を格納するが判定ロジックは現行維持」で 1 コミット、次に IL-04 で判定を goal ベースにする 2 段構えにする。
- LLM コンパイルされた goal(`compileIntentContractWithLlm`)は不確実性を含む。goal が空/低品質のときは汎用フォールバックに落ち、誤った具体ゴールを固定しない。
