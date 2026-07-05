# E2E-03: エージェント協調 — 「各自バラバラに処理」から「共通ゴールへの協調」へ

> 優先度: **P0**(中核ユースケース第3弾) / 規模: M〜L(タスク分割済み) / 依存: なし(MO-03/MO-04/HO-01/IL-01 の成果を利用。MO-02 は Codex 実装中 — Task 4 の注記参照)
> 実装担当モデル: 各タスクに明記。**gpt-5.4-mini クラス単独で実装可能な粒度**(README §2.1 の読み替え表に従う)
> 調査日: 2026-07-05(実コード検証済み。行番号は当日時点)

## 0.1 実装ステータス(2026-07-05 時点)

- 実装済み: Task 1(上流成果の自動注入)、Task 2(チームスナップショット注入)、Task 3(review 契約のスキーマ強制)、Task 4(指摘→修正→再レビューの往復)、Task 7(協調 E2E テスト)
- 未実装: Task 5(best-of-2 + judge)、Task 6(code_change ミッションの PR 協調)
- 補足: review タスクは `review_target` とその依存を両方満たす必要があるように、スキーマ検証を追加済み

## 0. 実装エージェントへ(E2E-01/02 と同じ規約)

- Task 内の手順を上から順に。変更前に対象ファイルを読み、行番号ずれは現状を正とする。
- ファイル I/O は `@agent/core`(secure-io)経由のみ。各 Task の「検証」全通過 + `pnpm lint && pnpm typecheck` で完了。
- **本計画の合言葉は「ワーカーに見えないものは協調できない」**: 協調の失敗はエージェントの怠慢ではなく、上流成果・仲間の状況・レビュー対象がプロンプトに載っていないことが原因。注入すれば協調する。

## 1. 症状と目指す姿

**症状**: implementer / reviewer / qa がそれぞれ自分のタスクを「単発の依頼」として処理する。レビューは対象成果物を特定せず一般論になり、修正は往復せず、成果物同士が整合しない。issue/PR 的な「同じ対象物を囲んだ協調」が起きない。

**目指す姿**:

```
planner が DAG を作る(依存つき)
→ implementer が成果物を出す(ゴール&仲間の状況を見ながら)
→ reviewer が「その成果物」を入力として指摘一覧を返す
→ implementer に rework packet として自動で差し戻る → 修正 → 再レビュー
→ high-stakes タスクは best-of-N + judge で最良案を採択
→ code_change は mission repo のブランチ+PR 上で同じ往復が起きる
```

## 2. 調査結果 — 協調の骨格は既にある。欠けているのは「可視性」と「往復」

**実装済みで動く部品(検証済み)**:

| 部品                                                                                 | 場所                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 依存つきタスク(`dependencies[]`)+ ready 判定(依存全 completed で発火)                | `mission-orchestration-worker.ts:190-199`               |
| **並列 dispatch**(ready 集合 → `max_parallel_members` 上限で `Promise.all` バッチ)   | `:1540-1666`(MO-03 は実装済み)                          |
| 受入ゲート + **1回の rework**(`rework_count` / `rework_requested`)                   | `:788-819`                                              |
| ミッション context pack(`outcome_contract.requested_result` / success_criteria 入り) | `mission-context-pack.ts:105-107,411`(MO-04)            |
| 構造化 task_result 契約(結論・artifact パス・verification・gaps・needs)              | `:314,400`(「file 内容を貼るな、結論とパスを返せ」規約) |
| 自己完結ハンドオフパケット                                                           | HO-01(2026-07-05 commit `bb7f632d`)                     |
| planner とは別コンテキストの planning reviewer                                       | `:1946-1947`                                            |
| PR 発行スクリプト                                                                    | `scripts/publish_pull_request.ts`                       |
| work item / board / attempt 台帳                                                     | `libs/core/work-coordination.ts:667-932`                |
| goal の state 永続化(元発話・success_condition)                                      | IL-01(`state.intent` / `outcome_contract`)              |

**切れている継ぎ目(ギャップ)**:

- **G1: 上流成果が下流に渡らない**。`dependencies` は**発火タイミングの制御にだけ**使われ、依存タスクの `task_result`(結論・artifact パス・verification)を下流タスクのプロンプトへ注入する箇所が存在しない(grep 実測: dependency の結果参照ゼロ)。reviewer は「何をレビューするか」を渡されず一般論を返す — **「個別で対処」の最大の原因**。
- **G2: 仲間の状況が見えない**。各 worker は自分のタスク契約と mission context pack しか見ない。「誰がどのタスクをどこまで終え、どの成果物が既に存在するか」のチームスナップショットがプロンプトに無い → 重複作業・スタイル不整合・既存成果物との矛盾。
- **G3: review タスクの契約が弱い**。planner が生成する NEXT_TASKS で、review タスクが「対象タスクへの depends_on + 対象成果物パス」を持つことは**プロンプト頼みで、スキーマ強制が無い**。対象を特定しないレビュータスクが平気で生まれる。
- **G4: 差し戻しが往復にならない**。受入ゲートの rework は**ゲート失敗時に1回**だけで、reviewer の指摘(request_changes 相当)を implementer への再タスクとして構造化して差し戻す経路が無い。レビュー結果はイベントログに書かれて終わる。
- **G5: 品質機構が休眠**(MO-07)。best-of-N・judge・敵対的レビュー・draft→refine は計画のみ。全タスクが1発出力で、high-stakes でも代替案比較が起きない。
- **G6: code_change が PR を囲まない**。per-mission git repo(micro-repo)と `publish_pull_request.ts` があるのに、implement 完了→ブランチ/PR→レビューコメント→修正、という「同じ diff を囲む協調」が未配線。各自がワークツリーに書くだけ。

## 3. ゴール(受入条件)

1. 依存タスクを持つタスクの dispatch プロンプトに、**依存タスクの task_result(結論・artifact パス・verification・gaps)が自動注入**される。
2. 全 dispatch プロンプトに**チームスナップショット**(各タスク1行: role / status / deliverable)が入り、「既存成果物と矛盾しないこと・重複しないこと」が規約として明記される。
3. review タスクは**スキーマで**対象タスク依存と対象成果物を強制され、指摘は構造化(`review_findings[]`)で返る。
4. request_changes 相当の指摘が implementer への **rework packet として自動再投入**され、修正→再レビューが最大2周する(無限ループ防止つき)。
5. `risk: high` / `risk_profile: high_stakes` のタスクは **best-of-2 + judge** で採択される(MO-07 の最小起動)。
6. `code_change` クラスのミッションでは implement 完了時にブランチ+PR が作られ、review タスクは **PR diff を入力**として受け取る。
7. fixture ミッション(stub backend)で 1〜6 が観測できる E2E テストが緑。

## 4. 実装タスク

### Task 1: 上流成果の自動注入 — `gpt-5.4-mini`(最重要・最小差分)

1. `mission-orchestration-worker.ts` の `dispatchPlannedMissionTask` のプロンプト組立(context pack を混ぜている箇所、`:544-565` 周辺)に以下を追加:
   - `task.dependencies[]` の各 ID について、NEXT_TASKS.json 上の該当タスクから保存済み task_result(完了時に書き戻される要約。書き戻しが無ければ `emitMissionTaskEvent` の evidence とタスクの `deliverable` を代用)を集め、
   - プロンプトに `## Upstream results (inputs you MUST build on)` 節として `- [task_id](role): summary / artifacts: <paths> / verification: <...> / gaps: <...>` を1タスク3行以内で注入する。
   - 該当結果が見つからない依存は `- [task_id]: completed (result summary unavailable — read the deliverable path from TASK_BOARD)` と明示(無言で欠落させない)。
2. task_result の書き戻し: dispatch 完了処理(`:400` 周辺で artifacts を集めている箇所)で、`task.last_result = { summary, artifacts, verification_done, gaps }` を NEXT_TASKS.json のタスクに永続化する(次回の Upstream 注入の正本)。
3. unit test: `mission-orchestration-worker.test.ts` の既存 fixture 流儀で「task-2(depends_on: task-1)の route ペイロードに task-1 の summary と artifact パスが含まれる」ことを固定。
4. **検証**: `pnpm exec vitest run libs/core/mission-orchestration-worker.test.ts`。

### Task 2: チームスナップショット注入 — `gpt-5.4-mini`

1. `buildTeamSnapshotLines(allTasks)` を worker 内に追加: 各タスク1行 `- task_id [role/agent] status deliverable`(completed は ✅、実行中は ⏳)。上限 20 行、超過は `... N more`。
2. Task 1 のプロンプトに `## Team snapshot (do not duplicate; stay consistent with completed work)` 節として注入。直後に規約2行: 「既に completed の成果物と用語・構成・スタイルを揃えること」「他タスクの担当範囲に踏み込まず、必要なら needs に書くこと」。
3. `mission-context-pack.ts` 側の予算(pruning)に収まるよう、snapshot は context pack でなく**プロンプト直付け**とし、`MO-04` の budget 計算には `estimated_chars` へ加算(該当箇所を読んで合わせる)。
4. **検証**: Task 1 と同じテストに snapshot 行のアサートを追加。

### Task 3: review タスク契約のスキーマ強制 — `gpt-5.4-mini`

1. NEXT_TASKS のスキーマ(`schemas/` 配下の該当スキーマを grep で特定。無ければ worker 内の検証ロジック)に条件付き必須を追加: `assigned_to.role が reviewer|qa のタスクは dependencies を1件以上持ち、params.review_target(対象タスクID)と deliverable(REVIEW-<target>.md のパス)が必須`。
2. planner へのプロンプト(NEXT_TASKS を生成させている箇所)に同じ規約を1行追記し、**生成後にスキーマ検証で弾く**(検証失敗は planning rework 経路へ — 既存の planning reviewer `:1946` の流儀)。
3. reviewer への dispatch プロンプトに、構造化返却の指示を追加: task_result の `gaps` を `review_findings` として使い、各指摘は `severity(must_fix|should_fix|nit) / location / instruction` の3要素で書く(自由文レビュー禁止)。
4. **検証**: 対象なし review タスクがスキーマ検証で blocked になる unit test / 正しい review タスクが通る test。

### Task 4: 指摘→修正→再レビューの往復 — `claude-sonnet-4` 相当(状態遷移の判断が要る)

> **MO-02(Codex 実装中)との棲み分け**: MO-02 はフェーズ単位のゲート(円環遮断含む)。本タスクは**タスク単位の review→rework 往復**で、対象ファイルも `dispatchPlannedMissionTask` の完了処理に限定する。着手前に `git log --oneline -10` で MO-02 の landed 分を確認し、`:788-819` の rework 機構が置き換わっていたらそちらの API に乗せる。

1. reviewer タスクの task_result に `must_fix` 指摘が1件以上ある場合:
   - 対象タスク(`params.review_target`)の status を `rework` に戻し、`task.rework_packet = { from_task, findings[], round }` を書く。
   - `rework_count` は既存フィールド(`:162`)を流用し、**上限2**(超えたら blocked + operator への NEXT_ACTION 1行 — 既存 `buildUnassignedRoleSummary` の流儀)。
   - rework 対象タスクの再 dispatch プロンプト先頭に `## Review findings to address (round N)` として findings を注入(Task 1 の機構を流用)。
2. 修正完了後、review タスクを**自動で再投入**(同じ reviewer、`round+1`、依存は修正タスク)。must_fix ゼロで往復終了。
3. 全遷移を `emitMissionTaskEvent` で記録(event_type は既存語彙から選ぶ。新設するなら `task_rework_requested` / `task_rereview_requested`)。
4. **検証**: unit test 3系 — must_fix あり→rework 投入 / must_fix ゼロ→終了 / round 上限→blocked。既存 dispatch テスト全緑。

### Task 5: MO-07 の最小起動(best-of-2 + judge)— `claude-sonnet-4` 相当

1. 対象条件: `task.risk === 'high'` または mission の `classification.risk_profile === 'high_stakes'` の implement 系タスクのみ(全タスク適用はコスト面で禁止)。
2. `dispatchPlannedMissionTask` で対象タスクを検出したら、**同一プロンプト+視点指示だけ変えた2並列**(`アプローチA: 最小実装優先` / `アプローチB: 堅牢性優先`)で route し、両 task_result を judge プロンプト(planning reviewer `:1946` と同じ「独立コンテキスト」の流儀。schema: `{ winner: 'A'|'B', rationale, merge_hints[] }`)に渡して採択。敗者の成果物は evidence 配下に `alternatives/` として保存(捨てない)。
3. 採択結果とコスト(2倍呼び出し)を task イベントに記録。`KYBERION_BEST_OF_N=0` で無効化可(既定は有効・対象条件が狭いため)。
4. MO-07 文書に「最小起動済み(best-of-2+judge)。draft-refine / 敵対レビュー全面適用は残余」とステータス追記。
5. **検証**: unit test — high risk タスクで route が2回+judge 1回呼ばれ、winner の結果が採用される / 通常タスクは1回のまま。

### Task 6: code_change ミッションの PR 協調 — `gpt-5.4-mini`(既存部品の連結)

1. `classification.mission_class === 'code_change'` のミッションで、implement タスク完了処理に追加:
   - mission micro-repo(`initMissionRepo` 済み)に `task/<task_id>` ブランチを切り、成果物をコミット(既存 `mission-git.ts` のヘルパーを流用)。
   - `scripts/publish_pull_request.ts` を `--repo <missionDir> --branch task/<id> --draft` 相当で呼べるか読んで確認し、ローカル micro-repo に GitHub remote が無い場合は **PR の代わりに `evidence/prs/<task_id>/diff.patch` + `PR.md`(タイトル/説明/変更ファイル一覧)を生成**(既定はこちら。remote があるときのみ実 PR)。
   - Task 4 の rework_packet(自動再投入 review)は round>=2 で必ず作動させる(コード変更はレビュー必須: review タスクが無ければ planner 契約違反として blocked)。
2. review タスクの dispatch プロンプトに、対象の `diff.patch`(2,000 行超は先頭+ファイル一覧に要約)を Upstream results として注入。
3. **検証**: fixture code_change ミッションで diff.patch と PR.md が生成され、review タスクのプロンプトに diff が含まれる unit test。

### Task 7: 協調 E2E テスト — `gpt-5.4-mini`

1. `tests/agent-collaboration-e2e.test.ts` を新設(stub backend、`mission-orchestration-worker.test.ts` の mock 流儀を流用):
   - fixture NEXT_TASKS: task-1(implement)→ task-2(reviewer, depends_on: task-1, review_target: task-1)
   - stub の task-1 応答に artifacts を含め、task-2 の route ペイロードに **task-1 の summary/artifacts と Team snapshot が含まれる**ことをアサート(G1/G2)
   - stub の task-2 応答に must_fix 1件 → task-1 が rework になり、rework プロンプトに findings が入る(G4)
   - 2周目で must_fix ゼロ → 両タスク completed、rework_count=1
2. **検証**: 本テスト + `libs/core/mission-orchestration-worker*.test.ts` 全緑。

## 5. リスクと注意

- **プロンプト肥大**: Upstream results / Team snapshot / findings の注入は MO-04 のコンテキスト予算内に収める(各節に行数上限を設けた。超過分は「TASK_BOARD を読め」への退避で対応)。
- **往復の暴走**: rework は上限2周・best-of は high-stakes 限定・re-review は同一 reviewer 固定。上限到達は必ず operator に見える形(blocked + NEXT_ACTION)で止める。無限ループより「止まって聞く」を優先。
- **MO-02 との整合**: Task 4 着手前に必ず MO-02 の landed 状況を確認(本文注記)。フェーズゲートとタスク往復は層が別だが、rework カウンタは共有フィールドなので二重加算しないこと。
- **コスト**: Task 5 は対象条件を狭く保つ。適用率とコストを task イベントから集計できるようにし、OP-01(コスト会計、Codex 実装中)が入ったら予算ゲートに接続する。

## 6. 実施順序

Task 1(上流注入)→ Task 2(snapshot)→ Task 3(review 契約)→ Task 4(往復)→ Task 7(E2E)→ Task 5(best-of)→ Task 6(PR 協調)。
**Task 1+2 だけで「個別対処」の体感は大きく変わる**(reviewer が対象を知り、implementer が仲間の成果を知る)。Task 4 で協調が閉ループになり、Task 5/6 は品質と外形の仕上げ。
