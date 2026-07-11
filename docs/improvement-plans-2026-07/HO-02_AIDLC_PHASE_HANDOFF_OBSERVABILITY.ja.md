# HO-02: AI-DLC フェーズハンドオフの自動化とハンドオフ可観測性

> 優先度: P2 / 規模: M〜L / 依存: MO-01(プロセステンプレート)、MO-02(ゲート)、HO-01(パケット) / 関連: AI_DLC_PLAYBOOK、AA-05(フロー観測)
>
> **なぜ重要か**: SDLC/AI-DLC を「適切に handoff する」というご依頼の核心。現状 AI-DLC は完全に人手コピペで、フェーズ間で文脈が毎回ゼロから再導出される。加えて「この作業を誰が持ち、何をして、何を渡したか」を一望する手段が無い。

## 背景と課題

- **AI-DLC が自動フローとして未実装**: `AI_DLC_PLAYBOOK.md` は人間向け散文ランブックで、各フェーズは手動 `npm run cli -- run <skill>` + コピペ `_Prompt:_`。`test-genie`/`local-reviewer`/`log-analyst`/`circuit-breaker` 等のロール名は **libs/scripts のどこにも出てこない**(grep ゼロ)。フェーズ間ハンドオフは 100% 人手で最大限 lossy: test-genie は人がペーストしたものを受け取り(playbook line 40)、local-reviewer は `git add .` の staged diff から全文脈を再導出(line 46-52)。circuit-breaker の「Phase 0 に戻る」(line 58)は**何が失敗し何を試したかを運ぶ state が無く**、ループバックで文脈全損。
- **対照的に Cowork 連携は最も成熟**(構造化パケット + 監査 + trace_id、Phases 0-3 実装済み `feature/cowork-integration-phase0`)。AI-DLC は成熟度の対極。
- **ハンドオフ履歴の統合ビューが無い**: work-coordination のイベント(`item_claimed/released/handed_off`、`work-coordination.ts:101-113`、`listCoordinationEvents :897`)で**誰が持ったか**は辿れるが、mid-flight ハンドオフは purpose のみで**何を渡したか**は薄い。mission ペルソナハンドオフ(`mission_controller.ts:1331`)・Cowork 配信(自己監査)・承認往復がそれぞれ別ストアに散り、「ある作業のハンドオフ履歴」を 1 タイムラインで見られない。

## ゴール(受入条件)

1. AI-DLC が MO-01 のプロセステンプレート `code_change` として**自動フロー化**され、フェーズ間に**フェーズ状態オブジェクト**が流れる: Alignment(TASK_BOARD)→ Execution 結果 → Test 出力 → Review 所見 → 失敗文脈。circuit-breaker の再 Alignment が「何が失敗し何を試したか」を受け取る(冷スタートしない)。
2. 各フェーズハンドオフが HO-01 の自己完結パケットを使い、次ロールが再導出せず継続できる。
3. **統合ハンドオフ履歴ビュー**: mission ペルソナハンドオフ + lease ハンドオフ + Cowork 配信 + 承認往復を、作業単位(相関 ID、IL-02)の 1 タイムラインに統合。
4. 人間の回答(question-resolver の OIP への回答)が、元のブリフを保ったまま停止中の実行に自己完結的に再突入する(IL-05/MO-06 と連携、AI-DLC の Review→人間→再開でも同じ機構)。

## 実装状況 (2026-07-11)

- **完了済み(Task 1 最小実証)**: `libs/core/aidlc-phase-state.ts` — `AiDlcPhaseState`(task_board_ref / execution_result / test_output / review_findings / failure_context / attempts[])と順序強制付きフェーズ遷移(Alignment→Execution→Test→Self-Review→complete)。下流フェーズは上流の構造化結果をデータとして受領(diff 再導出なし)。test/review ゲート失敗は自動で circuit breaker を作動し、failure_context(何が失敗・何を試した・残課題)付きで Alignment へ差し戻す。payload は summary+artifact_refs 形(MO-04 予算原則)。mission evidence への保存/再読込付き。スタブテスト5件。
- 残: MO-01 code_change テンプレートへの配線(Task 1.2/1.4)、統合ハンドオフ履歴ビュー(Task 2)、clean 再開(Task 3)、playbook 整合(Task 4)。

## 実装タスク

### Task 1: AI-DLC のフェーズ状態オブジェクト — `claude-sonnet-4`

1. `code_change` プロセステンプレート(MO-01)に AI-DLC の 5 フェーズ(Alignment→Execution→Test→Self-Review→Circuit-Breaker)を定義し、フェーズ間を流れる `AiDlcPhaseState { task_board_ref, execution_result, test_output, review_findings, failure_context, attempts[] }` を実装する。
2. 各フェーズ遷移(MO-02 のフェーズゲート)でこの state を次フェーズに HO-01 パケットとして渡す。test-genie 相当は Execution の構造化結果を受け取り(diff の再導出でなく)、local-reviewer は受入条件つきで受け取る。
3. circuit-breaker: 失敗時に `failure_context`(何が失敗・何を試した・残課題)を state に載せて Alignment へ差し戻す(MO-02 の circuit breaker と統合)。
4. playbook のロール(test-genie/local-reviewer/log-analyst)を実際のサブエージェント役割にマップ(agent manifest / team template)。
5. テスト(stub): Execution→Test→Review の state 継承、失敗→circuit-breaker で failure_context 付き差し戻し。

### Task 2: 統合ハンドオフ履歴ビュー — `claude-sonnet-4`

1. `pnpm work history <correlation_id>`(または AA-05 の `mission flow` に統合): `listCoordinationEvents`(lease)+ mission history(ペルソナ)+ 監査チェーン(Cowork 配信・承認)を相関 ID で突合し、「誰が持ち・何をして・何を渡したか」の 1 タイムラインを出す。
2. mid-flight ハンドオフの「何を渡したか」は HO-01 のパケットから取る(HO-01 が前提)。
3. 出力語彙は UX-05 準拠、confidential は参照のみ。AA-05 の mission flow と同じ相関キーで結合。
4. テスト: fixture での統合タイムライン。

### Task 3: 人間↔エージェントの clean 再開 — `claude-sonnet-4`

1. question-resolver の OIP(`:187`、最良の対人ハンドオフ)への回答が、停止中の実行に**元ブリフを保ったまま**再突入する経路を明示化(IL-05 の pending-intent 永続化 / MO-06 の journal 再開と統合 — 重複させず、それらの機構を AI-DLC の Review→人間承認→再開に適用)。
2. AI-DLC の Self-Review で人間承認が要る場合、HO-01 Task 3 のリッチ承認 framing で提示し、承認後に Execution/次フェーズへ文脈を保って戻す。
3. テスト: 人間回答後の clean 再開(文脈保持)。

### Task 4: playbook とドキュメント整合 — `claude-haiku`

- `AI_DLC_PLAYBOOK.md` に「自動フロー版は MO-01 の code_change テンプレート + HO-02 として実装。手動ランブックは fallback/学習用」と明記。MO-01・MO-02 との対応表を追記。

## リスクと注意

- AI-DLC の自動化は大規模。**まず state オブジェクトの受け渡し(Task 1)を最小フェーズ(Execution→Test)で実証**し、全 5 フェーズ + circuit-breaker は段階的に。人手ランブックは当面 fallback として残す(いきなり全自動化しない)。
- フェーズ状態が肥大化しやすい(diff・ログ全文)。state は参照 + 要約中心にし(MO-04 の予算原則)、全文は成果物ストアに置いて ref を渡す。
- 統合履歴ビューは複数ストア横断で重い。相関 ID インデックス前提、ページング。AA-05 の実装と統合して二重にしない。

## ステータス追記(2026-07-07)

E2E-05 Task 4 の `pipelines/sdlc-cycle.json` により、中核ギャップ「工程間の人手コピペ」は1本のパイプラインで塞がった(intent → requirements → design → task-plan → NEXT_TASKS → test-plan)。以降の工程可視化・handoff 観測は本計画の残余スコープ。
