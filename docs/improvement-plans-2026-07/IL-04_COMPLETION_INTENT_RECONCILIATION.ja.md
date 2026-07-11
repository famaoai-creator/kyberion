# IL-04: 完了とインテントの突合 — 「完了」を「意図が満たされた」に一致させる

> 優先度: **P0** / 規模: M / 依存: IL-01(実 goal)/ 関連: MO-02(受入ゲートはタスク単位、IL-04 はミッション全体 vs 元 intent)、UX-01(結果提示の体裁)
>
> **なぜ重要か**: INTENT_LOOP_CONCEPT §2 の不変条件「intent-match が確認されない限り成果物は complete でない」に**最も直接的に違反**している箇所。現状の "completed" はライフサイクル上の主張であって、ユーザーの依頼が満たされた確認ではない。

## 背景と課題

完了が「元の依頼」に一度も突き合わされない。

- ミッション finish サマリは汎用の `outcome_contract.requested_result` を使う(`mission-lifecycle.ts:302`)。「あなたは X を頼み、Z を届け、残ギャップは W」という突合ステップが無い。
- `next-action.ts` は**エラー駆動専用**(`buildNextActionFromError`、`:220`。全分岐が失敗分類)。成功完了→intent へのマッピングが無い。
- task-session の完了検証は「success_criteria が非空 + (evidence_required なら)artifact ref が在る」だけ(`outcome-contract.ts:44-60`)で、`evidence_required` は既定 `false`(`:83`)。つまり "completed" は構造/ライフサイクルの主張で、intent 充足の確認ではない — §2 が警告する「表面的な完了」そのもの。
- goal.success_condition と成果物を比較するコードは存在しない。

## ゴール(受入条件)

1. **クロージング突合ステップ**が実装され、完了時に「元の依頼(IL-01 の実 goal)vs 実際の成果物」を突き合わせ、`{ satisfied: bool, delivered: [...], gaps: [...] }` を生成する。
2. 完了が**この突合に gate される**: 未充足(重大 gap あり)なら「completed」にせず、ユーザーに gap を提示して継続/承認を求める。
3. 完了時にユーザーへ「依頼: X / 成果: Z / 残: W / 次の一手」が提示される(UX-01/UX-02 の提示機構を使用、全 shape 共通)。
4. 軽量パス(direct_reply / task_session)にも最小の close-the-loop(goal を復唱し満足を確認)が入る(§2 の loop 閉包は shape に依らない)。
5. 突合結果が学習(⑥)と intent-contract-memory(IL-02 の相関付き)に記録される。

## 実装タスク

### Task 1: 突合エンジン — `claude-sonnet-4`

1. `libs/core/intent-reconciliation.ts` を新設: `reconcileCompletion({ goal, deliverables, evidence }): { satisfied, delivered[], gaps[], confidence }`。判定は (a) goal.success_condition の各項が成果物/evidence で満たされるかの構造チェック + (b) reasoning backend が非 stub なら「この成果物は『<goal>』を満たすか、満たさない点は何か」の 1 回問い合わせ。stub 時は構造チェックのみ + `confidence: low`。
2. IL-03 のドリフト判定とロジック(goal 充足方向の評価)を共有する。
3. unit test: 充足/部分充足(gap 抽出)/未充足、stub と非 stub。

### Task 2: 完了ゲートへの組み込み — `claude-sonnet-4`

1. ミッション finish(`mission-lifecycle.ts:229` 周辺、MO-02 の finish ゲートと同居)に突合を追加: 重大 gap があれば completed にせず `validating` に留め、gap を差分タスク化(MO-02 の rework 経路)。
2. task-session 完了検証(`task-session.ts:1049`、`outcome-contract.ts:44-60`)に突合を追加。`evidence_required` の既定は据え置きつつ、goal が成果物を含意する場合(IL-01 Task 2)は突合で evidence 不在を gap として扱う。
3. テスト: gap ありで完了ブロック、充足で完了。

### Task 3: クロージング提示(全 shape 共通)— `claude-sonnet-4`

1. `next-action.ts` に**成功完了経路**を追加(現状エラー駆動のみ): `buildCompletionNextAction({ goal, reconciliation })` が「依頼 / 成果 / 残ギャップ / 次の一手」を構造化。
2. ミッション finish サマリ(`mission-lifecycle.ts:302`)と、軽量パス(`handleSurfaceQueryRoute` `:115`、`handleTaskSessionRoute` `:214`)の応答末尾に、この突合クロージングを付ける。direct_reply でも最小形(「ご依頼の X について回答しました。他に必要な点はありますか」+ 未解決フラグ)を出す。
3. 提示は UX-01(体裁)・UX-05(語彙)に準拠。confidential は tier 配慮。
4. テスト: 各 shape でクロージングが出ること。

### Task 4: 学習への記録 — `claude-haiku`

- 突合結果(satisfied / gaps)を `recordIntentContractOutcome`(`intent-contract-learning.ts:241`)と intent-contract-memory(IL-02 の相関付き)に記録。gap のパターンは AC-02 の需要ループや KM-03 の昇格候補に流れ、「よく取りこぼす依頼型」が学習される。

### 実装メモ — 2026-07-04

- `libs/core/next-action.ts` に完了用の構造化 next-action を追加し、`scripts/refactor/mission-lifecycle.ts` の finish で `mission_completion_next_action` と `mission_completion_summary` を state.context に記録するようにした。
- `libs/core/next-action.test.ts` で満足済み/未充足の両ケースを固定した。

## 実装メモ

- `libs/core/intent-reconciliation.ts` を新設し、`goal.success_condition` と evidence を構造的に突合する `reconcileCompletion` / `reconcileCompletionStructurally` を実装した。
- `libs/core/task-session.ts` の完了保存時に突合ゲートを追加し、未充足のまま `completed` にできないようにした。
- 完了時には `completion_summary` と `completion_next_action` を task-session に永続化し、`task-session.schema.json` でもトップレベル項目として受けるようにした。
- task-session 完了時の intent_id がある場合は `recordIntentContractOutcome` へ `completion_summary` を書き戻し、`intent-contract-memory` に満足/ギャップの学習結果を残すようにした。
- ミッション finish 側は `scripts/refactor/mission-lifecycle.ts` で突合結果を取り込み、完了サマリと次アクションを state.context に残すようにした。

## リスクと注意

- 突合ゲートは**完了を止め得る**。誤って「未充足」と判定して完了をブロックすると体験が悪化する。まず warn(gap を提示するが完了は通す)で観測 → gap 抽出精度を確認 → enforce。重大度でゲート強度を分け、軽微 gap は completed + 注記に留める。
- 非 stub 突合は LLM コストを足す。完了時 1 回のみ(ステップごとでない)に限定し、goal が明確なミッションのみフル突合、軽量パスは構造チェック中心。
- 「satisfied」の過信は禁物。confidence を必ず添え、low の場合はユーザーに「自動確認は低信頼です。ご確認ください」と正直に出す(UX-01 の正直さ原則)。

## 実装状況 追記(2026-07-08)— Goal Satisfaction Loop(Task 2 mission 側完了)

受入条件 2 の mission 側「完了が突合に gate される」を、単なるブロックではなく**自律クローズループ**として実装:

- `finishMission`(`scripts/refactor/mission-lifecycle.ts`)に **goal-satisfaction ゲート**を追加。`reconcileCompletion` が未充足(gaps あり)なら completed にせず:
  - **gap を差分タスク化**: gap ごとに implementer タスク+reviewer タスク(`goal-gap-r<round>-<n>` / `-review`、review_target 付き)を NEXT_TASKS に upsert。acceptance_criteria に gap 本文+goal summary+success condition を明記するため、成果 evidence が gap 文言を含む形になり**次回突合で構造的に収束**する。
  - mission を `active` に戻し(`GOAL_GAP_REALIGN`)、orchestration worker(E2E-03 の review 往復・best-of-N)がそのまま回す。
  - 上限 `KYBERION_GOAL_LOOP_MAX_ROUNDS`(既定 2、0 で無効)。超過時は標準 finish-gate 失敗経路(`repair-goal-satisfaction` タスク+validating)+ `notifyOperator('mission_failed')` で**人間の判断に載せる**。
  - 充足時は `goal-satisfaction` gate record(pass)を evidence に残す。
- **字面→目的の貫通(worker 側)**: `dispatchPlannedMissionTask` の全プロンプトに `## Mission goal` セクション(goal summary / success condition / 「タスクの字面がゴールと矛盾するなら literal に完了せず gaps/needs で言え」)を注入(`buildMissionGoalLines`)。これまで worker はタスク description しか見ていなかった。
- テスト: `mission-lifecycle.test.ts`(gap タスク投入→active 復帰、上限超過→validating+repair タスク)、`code-change-pr-collaboration.test.ts`(プロンプトへの goal 注入)。

これで「依頼受領 → 解釈された goal(IL-01)→ 実行(E2E-03 協調)→ 完了突合(IL-04)→ **未達なら gap を自動で作業に還流** → 充足で完了 or 上限で operator」のループが閉じた。

## 実装状況 追記 (2026-07-12)

**再突合: 受入条件5点すべて実装・テスト済みを確認 — IL-04 は DONE。**
突合エンジン(intent-reconciliation.ts + テスト)/ 完了ゲート(task-session 保存時 + mission finish)/ クロージング提示(mission finish サマリ・task_session・direct_reply の全 shape、buildCompletionNextAction / buildDirectReplyCompletionAction)/ 学習記録(completion_summary → recordIntentContractOutcome → intent-contract-memory)。関連テスト 21 本緑。
