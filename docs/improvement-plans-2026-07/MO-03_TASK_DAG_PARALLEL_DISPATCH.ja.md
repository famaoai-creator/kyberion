# MO-03: タスク契約と DAG 並列分配 — 直列 for ループからの脱却

> 優先度: P1 / 規模: M〜L / 依存: MO-01 / 関連: MO-02(受入ゲート)、MO-04(コンテキスト)
>
> **参考にしたハーネス原則(Fable 5)**: (1) 多段作業の既定は**アイテム独立のパイプライン**(アイテム A がステージ3にいる間にアイテム B はステージ1でよい)。**バリア(全員待ち合わせ)は「全アイテムの結果を横断して使う」時だけ**正当化される。(2) fan-out の前に scout で作業リストを確定する(計画 = 作業リストの発見)。(3) 同時実行は並列度キャップ付きでキューイングする。(4) 依存の無いタスクを直列に待つのは純粋な無駄。

## 背景と課題

- **分配は直列**: `dispatchMissionNextTasks` は `for … await a2aBridge.route()` で 1 タスクずつ送り、**各タスクの完了応答を待ってから次を送る**(`mission-orchestration-worker.ts:412-502`)。エージェント間の並列性はゼロ。
- **DAG が無い**: 永続化されるタスク形は `task_id/description/deliverable/target_path` のみ(`persistPlanningPacket` `:247-256`)。`dependencies` も `acceptance_criteria` も無い。`status==='planned'` の配列順で処理される(`:394`)。
- **並列度は宣言だけ**: `MissionTeamLifecyclePolicy.max_parallel_members`(`mission-team-plan-composer.ts:41,87-96`)を dispatcher は読まない。設計文書は並列 worker とリース、dependency-first dispatch を明記している(`agent-mission-control-model.md:151-152,101-104`)のに未実装。
- **基盤の二重化**: リース・楽観バージョン・依存フィールド・handoff を持つ `work-coordination.ts`(`WorkItem.dependencies` `:24,55`、`claimWorkItem` `:937-996`)と、worker が実際に使う `NEXT_TASKS.json` + in-memory bus が別物。リース/競合検出はミッションタスクに適用されていない。
- ロール未充足タスクは黙って skip(`:414-415`)。

## ゴール(受入条件)

1. タスク契約スキーマが拡張され(`dependencies[]`, `acceptance_criteria[]`, `risk`, `expected_output_format`, `estimated_scope`)、planner の出力がこれで検証される。
2. dispatcher が**依存解決済みのタスクを並列に発行**する(トポロジカル ready 判定 + `max_parallel_members` キャップ + 完了ごとに次の ready タスクを投入)。依存の無い N タスクは同時に走る。
3. ミッションタスクの実行状態が `work-coordination` のリースモデルに統合され(claim → attempt → complete/handoff)、二重基盤が解消に向かう(最低限、mission タスクがリースで排他される)。
4. ロール未充足は skip でなく `blocked(unassigned_role)` + owner 通知になる。
5. 逐次実行との結果同等性がテストで保証される(同 fixture で並列/直列の最終成果が一致)。

## 実装タスク

### Task 1: タスク契約スキーマ — `claude-sonnet-4`

1. `schemas/mission-task-contract.schema.json` を新設: 既存 4 フィールド + `dependencies: string[]`(task_id 参照)、`acceptance_criteria: string[]`(検証可能な文で 1〜5 個)、`risk`、`expected_output_format`(`text|files|structured`)、`estimated_scope`(`S|M|L`)。
2. planner へのプロンプト(kickoff の planning_packet 依頼文)にスキーマとサンプルを埋め込み、`persistPlanningPacket` で Ajv 検証 → 不合格は planner に 1 回だけ修正再依頼(MO-02 Task 2 の計画ゲートと同居)。
3. 依存の循環検出(トポソート失敗)を検証に含める。unit test: 正常/循環/欠落参照。

### Task 2: 並列ディスパッチャ — `claude-sonnet-4`

1. `dispatchMissionNextTasks` を書き換える: (a) 依存が全て `completed` のタスクを ready 集合として抽出、(b) `max_parallel_members`(既定 3)を上限に同時発行、(c) 1 件完了(受入ゲート通過)するたびに ready を再評価して補充、(d) 全タスク終端(completed/blocked)で followup 完了。`a2aBridge.route` の同時実行安全性(runtime daemon の多重リクエスト可否)を最初に確認し、不可なら agent 単位のキュー(同一 agent へは直列、異 agent へは並列)にする。
2. 発行順の決定性: ready 集合内は task_id 昇順(再実行時の再現性のため)。
3. タイムアウトと孤児回収: タスクごとに timeout(estimated_scope から既定値)を設け、超過時は `blocked(timeout)` として後続の依存タスクを blocked 連鎖させる(黙って待ち続けない)。
4. テスト: モック a2a で「依存チェーン A→B、独立 C,D」fixture が並列度 2 で正しい順序・回数で発行されること、timeout 経路、直列モード(`max_parallel_members: 1`)との結果同等性。

### Task 3: リースモデルへの片寄せ(第一歩)— `claude-sonnet-4`

1. dispatch 時に `work-coordination` の WorkItem をタスクごとに作成し、発行前に `claimWorkItem` でリースを取る(既存 API `work-coordination.ts:937-996` を利用)。受入ゲート通過で complete、rework は attempt 増分、handoff は既存機構に乗せる。
2. `NEXT_TASKS.json` は当面「planner 出力 + 表示用ビュー」として残し、実行状態の正は work-coordination 側とする(reconciliation の集計元を切り替え)。完全廃止は影響範囲を見て次段に回し、本文書に判断を追記する。
3. 併走防止テスト: 同一タスクへの二重 claim が版競合で防がれること。

### Task 4: 未充足ロールのエスカレーション — `claude-haiku`

- `:414-415` の silent skip を `blocked(unassigned_role)` + オーナー向けサマリ 1 行(「タスク X はロール Y が未割当のため停止中」)に変更し、テストを 1 本追加する。

## リスクと注意

- 並列化は**書き込み競合**を顕在化させる(同一ファイルを触る 2 タスク)。planner プロンプトに「同一 target_path を持つタスクには依存を張る」規則を明記し、dispatcher でも同一 `target_path` の同時発行を禁止する(安全側の直列化)。
- runtime daemon / provider のレート制限に当たりやすくなる。`max_parallel_members` の既定は 3 に抑え、provider エラー時は並列度を一時的に 1 へ落とすバックオフを入れる。
- 並列化で Slack 通知が混線しないよう、進捗通知は reconciliation 単位に集約する(タスクごとの逐次通知をやめる)。

## 実装メモ

### Task 2 slice — 2026-07-04

- `dispatchMissionNextTasks` は ready 集合を `max_parallel_members` で打ち切り、task_id 昇順で同時発行するように切り替えた。
- `libs/core/mission-orchestration-worker.test.ts` に依存チェーンのディスパッチ/保留を固定するテストを追加した。
- `libs/core/mission-orchestration-worker.test.ts` に、並列 cap 内での task_id 順序と同時 route 発行を固定するテストを追加した。
