# MO-02: フェーズゲートの実効化 — 自己申告ではなく検証された証拠で前進する

> 優先度: **P0** / 規模: M〜L / 依存: MO-01(型別テンプレート) / 関連: IP-07(テスト基盤)
>
> **参考にしたハーネス原則(Fable 5)**: (1) 計画は実行前に承認ゲートを通す(plan mode / ExitPlanMode 相当)。(2) 完了主張は信用せず、**成果物を実際に動かして観測する**(verify)。(3) 重要な発見・成果はデフォルトで疑い、独立した検証者に**反証を試みさせる**(adversarial verify、多数決)。(4) 失敗したらフェーズを巻き戻す(circuit breaker)。ゲートは「進んだ後で気づく」のではなく「進む前に落とす」ために置く。

## 背景と課題

自動化されたミッション遂行に**フェーズ間ゲートが実質存在しない**。

- orchestration worker はイベントを無条件連鎖させる: `issue → team_prewarm → kickoff → followup → reconciliation → distillation → completion`(`mission-orchestration-worker.ts:920-951`)。distill/finish の失敗は Slack にログされるだけで止まらない(`:803-804,829-830`)。
- 唯一の実質ゲートは **finish 時**の `evaluateMissionIntentDrift` + `validateMissionQuality`(`mission-lifecycle.ts:223-239`、`mission-governance.ts:71-124`)。最終段で初めて落ちる構造で、しかも落ちても自動 re-entry ループが無い。
- `verify` は**人間の申告動詞**(`verify <ID> verified|rejected`、`mission-lifecycle.ts:132-183`)。`validating` ステータスは import 経路でしか入らない(`:113`)。
- 名前付きゲート(`gatePass`/`gateFail`、`mission_controller.ts:1361-1407`)は evidence ファイルのフラグ反転のみで、遷移に接続されていない。absorption plan のゲート語彙(`ARCHITECTURE_READY` 等)は文書のみ。
- タスク完了は `NEXT_TASKS.json` の**自己申告ステータスを信用**して集計される(`reconcileTaskOutcomeEvents`、`:297-325`)— worker 自身は `requested`/`blocked` しか書かないのに、`completed/accepted` が外部から書かれる前提。
- 独立レビュアー/Observer は設計(`agent-mission-control-model.md:48-56`)にあるが spawn されない。「成果物を動かして確認する」ステップはどこにも無い。

## ゴール(受入条件)

1. **計画ゲート**: planner の `planning_packet` は、スキーマ検証 + 計画レビュー(下記 Task 2)を通るまで dispatch されない。
2. **タスク受入ゲート**: 各タスクの完了は、(a) 成果物の存在 + 受入条件(acceptance_criteria)との突合、(b) `code_change` 型ではテスト/lint 実行結果、を自動確認してから `completed` になる。リスク `approval_required|high_stakes` のタスクは**独立レビュアー・エージェント**(実装者と別コンテキスト)の合格が必須。
3. **フェーズ exit ゲート**: process template(MO-01)の `exit_gate` が評価され、不合格ならフェーズを進めず、規定回数失敗で **circuit breaker**(AI_DLC playbook Phase 4 相当: Alignment へ差し戻し + オーナー通知)が発動する。
4. finish ゲート不合格時、completion イベントを発行せず `validating` に留めて再修正ループに入る。
5. すべてのゲート判定が evidence ファイル + trace に記録され、`gatePass/gateFail` の手動動詞は override(理由必須)として残る。

## 実装タスク

### 実装メモ

- `libs/core/mission-gate-engine.ts` を追加し、`evidence_exists` / `schema_valid` / `command_succeeds` / `reviewer_approved` / `human_override` / `custom` の評価と JSON レコード永続化を共通化した。
- `mission-orchestration-worker.ts` のタスク受入経路で、`task_result` スキーマ・証跡・acceptance criteria の突合を gate 化し、合格時のみ `completed` に進める。
- `mission-orchestration-worker.ts` の planning 経路で、planning_packet のスキーマ検証と独立レビュー結果を `gates/` に記録するようにした。
- `mission-orchestration-worker.ts` の planning gate record には planner / reviewer / review round / review verdict を埋めるようにした。
- `mission_controller` の `gate-pass` / `gate-fail` は、同形式の override レコードを gates 配下に残す実装へ寄せた。
- `mission-lifecycle.ts` では finish 時に intent drift / exit / quality を判定し、失敗時は validating を維持して修復タスクを NEXT_TASKS.json に残す。

### Task 1: ゲート評価エンジン — `claude-sonnet-4`

1. `libs/core/mission-gate-engine.ts` を新設: ゲート定義(`{ id, checks: [{ kind: 'evidence_exists' | 'schema_valid' | 'command_succeeds' | 'reviewer_approved' | 'human_override', params }] }`)を評価し、`{ verdict: pass|fail, reasons[], evidence_path }` を返す。`command_succeeds` は secure-io/safeExec 経由でテスト・lint 等を実行する(`validateMissionQuality` の既存チェック実装を可能な限り再利用)。
2. 判定結果は `missions/<id>/gates/<gate_id>-<ts>.json` に永続化し、`gatePass/gateFail` は同形式の override レコードを書く形に統一する。
3. unit test: 各 check 種の pass/fail、override の監査記録。

### Task 2: 計画ゲート — `claude-sonnet-4`

1. `persistPlanningPacket`(`mission-orchestration-worker.ts:243-258`)の前に、(a) タスク契約スキーマ検証(MO-03 Task 1 のスキーマ)、(b) **計画レビュー**: planner とは別の 1 エージェントに「この計画で deliverable に到達するか。抜けている依存・検証は何か」を構造化出力(`{ approve: boolean, gaps: [] }`)で問わせる。reject 時は gaps を添えて planner に 1 回だけ再計画させ、再 reject なら owner へエスカレーション。
2. リスク `low` のミッションはスキーマ検証のみ(レビューをスキップ)にして軽量に保つ。

### Task 3: タスク受入ゲート — `claude-sonnet-4`

1. dispatch 結果の受領時(`dispatchMissionNextTasks` の応答処理)に受入評価を追加: 成果物パスの存在、acceptance_criteria(MO-03 で契約に追加)ごとの確認、`code_change` では対象範囲のテスト実行。合格で `completed`、不合格は `rework_count` を 1 回だけ増やして同一 worker に再依頼し、2 回目でも不合格なら `blocked` + owner 通知。
2. **独立レビュアー**: リスク高タスクでは、実装者と別のエージェント(team plan の reviewer ロール。未割当なら planner ロールで代替)に「反証を試みよ(このコードが受入条件を満たさないケースを探せ)」という敵対的プロンプトでレビューさせ、`{ refuted: boolean, findings[] }` を受入判定に合成する。
3. `NEXT_TASKS.json` のステータス遷移を worker が一元管理し、外部書き込み前提を廃止する(`reconcileTaskOutcomeEvents` はゲート記録から集計する形に変更)。

### Task 4: フェーズ exit ゲートと circuit breaker — `claude-sonnet-4`

1. worker のフェーズ遷移(MO-01 Task 4 でテンプレート駆動化済み)に `exit_gate` 評価を挿入。不合格時: 同フェーズ内の再試行(上限 2 回)→ 上限超過で `mission control` に `realign` イベントを追加し、Alignment 相当(planner への再計画依頼 + owner への状況サマリ)に巻き戻す。
2. finish ゲート不合格時は completion イベントを発行せず status を `validating` に設定、差分修正タスクを生成して followup へ戻す。
3. E2E テスト(stub backend): 合格一直線 / タスク不合格→rework→合格 / exit 不合格→circuit breaker、の 3 シナリオ。

### Task 5: 可観測化 — `claude-haiku`

- TASK_BOARD.md とオーナー向けサマリに、フェーズ・ゲート状態(✅/❌/override)・rework 回数を表示する。`docs/developer/playbooks/AI_DLC_PLAYBOOK.md` に「この playbook は code_change テンプレート + ゲートとして自動化された」旨の対応表を追記する。

## リスクと注意

- ゲートはレイテンシとトークンを消費する。**リスク軸で強度を段階化**(low: スキーマのみ / review_required: 受入評価 / approval_required+: 独立レビュー)し、全ミッション一律の重装備にしない。
- 敵対的レビューは false positive(正しい成果物への言いがかり)を出す。レビュー結果は自動棄却でなく rework 理由として実装者に渡し、2 者で収束しない場合のみ人間へ(自動の無限ループを作らない — rework 上限 1 回を守る)。
- stub reasoning backend ではレビューが形骸化するため、ゲートの E2E テストはレビュー応答を fixture で注入する。

## 実装状況 (2026-07-12)

**受入条件1/2/4/5 は実装済みを再突合で確認、3(フェーズ exit ゲート)を今回実装 — MO-02 の主要ギャップは解消。**

- **再突合(実装済みだった項目)**: 計画ゲート(planning_packet スキーマ + 独立レビュー、gates/ 記録)/ タスク受入ゲート(evidence + acceptance_criteria + task_result スキーマの gate 化、rework_packet / reviewer ロール検証)/ finish 不合格時の validating 維持 + 修復タスク + 2回失敗で realign(mission-lifecycle)/ gate-pass・gate-fail の override 記録 / TASK_BOARD・サマリへの Gate Status 表示。
- **今回実装(受入条件3)**: process template の `exit_gate` は planning 時に `gates/definitions/` へ永続化されるだけで**評価する消費者が存在しなかった**。worker に `evaluateMissionPhaseExitGates` を新設し、completion イベント発行前に全 exit gate を評価・記録。`reviewer_approved` チェックは NEXT_TASKS.json のタスク結果から enrichment(template の params は task_id のみのため)。共通作業規約4 に従い **既定 warn**(記録・通知のみ)、`KYBERION_PHASE_GATE_MODE=enforce` で completion をブロック、同一ゲート 3 回目の失敗で circuit breaker イベント(realign 推奨)を通知。テスト5本(warn/enforce/off、定義ロード、evidence 合否、prior_failures 計数、reviewer enrichment)。
- **human_override 署名強制 実装(2026-07-12)**: `signHumanOverride({gateId, approvedBy})` が gate id・承認者・時刻に HMAC(A2A 秘密鍵共用)を束縛した params を生成し、評価側が検証。`KYBERION_GATE_OVERRIDE_SIGNATURE` は既定 warn(旧挙動維持 + 警告ログで観測)→ enforce で未署名/改竄/他ゲート流用を拒否。テスト6本。
- **既知の限界(更新)**: enforce への切替は warn 観測でゲート失敗分布を確認してから(egress と同じ運用)。realign の完全自動化(planner 再計画の自動起動)は circuit breaker 通知に留めた。
