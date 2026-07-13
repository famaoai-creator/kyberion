# ループ完結計画(LC)— 決定論×LLM 協調の4ループを閉じる

> **作成日**: 2026-07-13
> **根拠**: 実コード突合調査(推論バックエンド/ADF 実行・修復/却下・再実行の3系統を並列調査、file:line 検証済み)+ [STATUS.ja.md](./STATUS.ja.md) 突合。
> **位置づけ**: Kyberion の製品テーゼ —「決定論的な実行と LLM 推論をどの結合点で組み合わせるか。ナレッジから決定論に落とせるものは落とす蒸留。組織・ミッション等の情報資産の統制とエビデンス」— を**運転し続けるための4つのループ**を、既存機構の活用マップと真のギャップ(LC-01〜12)として計画化する。既存 IP の再設計ではなく**縫い合わせ**が主眼。

## 0. 4つのループと結論

| ループ                    | 内容                                                 | 現状の到達点                                                                   | 主ギャップ |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| **L1 実行成功→昇格**      | ADF を書く→try&error→動く ADF→再利用なら pipeline 化 | 修復ループは AR-01 Phase B で統合済み。**昇格ツールは不在(完全手動)**          | LC-01〜03  |
| **L2 LLM 判断配置**       | どのポイントで LLM/サブエージェントに頼むか          | AR-07 で「蒸留→一点判断」「選択>生成」の型が確立、HN-02/MO-05 完了             | LC-04〜06  |
| **L3 縮退防止**           | モデル障害時に stub へ静かに落ちて変にならないか     | **実行中は安全**(failover→throw)。**インストール時と構造化出力に無音経路あり** | LC-07〜09  |
| **L4 人間フィードバック** | 却下→なぜかを聞く→改善→再実行                        | 却下理由は捕捉されるが**終端レコード止まり。再実行にも学習にも流れない**       | LC-10〜12  |

**「まず成功まで持っていき、再利用が必要になったら pipeline 化」は正しい方針であり、本計画で正式ドクトリン化する**(§1.1)。理由: 未成功の作業を先に凍結すると「動かない ADF の保守」が生まれる。成功トレースという証拠を持ってから昇格する方が、AGENTS.md §2 の「Promote repeated deterministic work into a pipeline」とも一致し、昇格判断も決定論化できる(再実行見込み・同型パターン反復数という観測可能な基準)。欠けているのは方針ではなく**昇格を安価にするツール**である(LC-02)。

---

## 1. L1: 実行成功→再利用昇格ループ

### 1.1 ドクトリン(正本化する運転手順)

```
① 書く: workflow-as-code(HN-03)または JSON ADF を draft
② 検証: readValidatedWorkflowAdf(schema + guardrails)で preflight
③ 実行: 失敗したら runStepWithRepair(1回修復+1回再試行, AR-01 Phase B)
④ 成功: そこで止まってよい(一回きりの仕事はここで完了)
⑤ 昇格判断: 「再実行の見込みがある」or「同型が反復する」→ pipeline 化
⑥ 昇格: 成功ランの実行記録から pipelines/*.json へ昇格(LC-02)
```

現状の裏付け: preflight は `scripts/refactor/adf-input.ts:46-60`(`validatePipelineAdf` → `validatePipelineGuardrails`、error は throw)。runtime 修復は `scripts/run_pipeline.ts:893-978`(`runStepWithRepair`、`attempt < 2` の有界ループ)+ `libs/core/autonomous-repair.ts:51-127`(LLM サブエージェント修復、permission/auth/config/env は fail-closed で ops エスカレーション)。修復結果は**元ファイルへの in-place 上書き**で永続化される。

### LC-01: 決定論修復の復権(修復カスケードの「決定論→LLM」順序化) — P1 / S

- **問題**: 決定論 JSON 修復(`tryRepairJson`)を持つ `validateAndRepairAdf`(`libs/core/adf-repair-agent.ts:33-95`)は**本番呼び出し元がゼロ**(テストのみ)。実行時修復 `attemptAutonomousRepair` は最初から LLM に投げるため、括弧欠落・カンマ等の機械的破損にもトークンを使い、stub 環境では修復不能になる。
- **実装**: `attemptAutonomousRepair` の前段に `tryRepairJson` → 再 validate の決定論カスケードを挿入(adf-repair-agent の既存実装を共有化)。LLM 委譲は決定論修復で解決しない場合のみ。
- **受入**: 構文破損 ADF が LLM 呼び出しゼロで修復されるテスト / 意味的破損は従来どおり LLM に到達するテスト。担当: sonnet。

### LC-02: 成功ランの pipeline 昇格ツール(`pipeline:promote`) — **P0(本計画の中核)** / M

- **問題**: 成功した一回きりの実行を `pipelines/*.json` に昇格する経路が**完全手動**。トレース→text hint(`libs/core/src/feedback-loop.ts`)と記憶蒸留(review.md → HINTS.md)はあるが、**トレース→pipeline の蒸留は概念のみ**(`kyberion-concept-map.md:82` の "Generated Pipeline" に実装なし)。昇格が高コストだと「再改殮(re-improvising)」が既定になり、AGENTS.md §2 が絵に描いた餅になる。
- **実装**:
  1. `pnpm pipeline:promote --trace <traceId|last>`: 成功トレース/実行済み ADF から、(a) 実行された step 列と解決済みパラメータを抽出、(b) 入力値をプレースホルダ化(`{{...}}`)、(c) LLM ワンショットで「凍結してよい決定論 step」と「毎回判断が要る semantic brief(AR-07 op)」に分類、(d) preflight を通した上で `pipelines/` に書き出し + `pipelines/README.md` カタログ行を生成。
  2. 昇格判断の提案: `run_pipeline` 終了時、同型実行の反復を検出したら(intent-contract-memory の同型 intent 数 ≥3)「昇格候補」として operator packet に1行提示(強制しない)。
  3. 修復で in-place 上書きされた ADF は昇格時に「修復済み」の出自(trace 参照)を frontmatter に記録。
- **受入**: 実際の成功ラン1件から生成した pipeline が preflight 緑で再実行可能 / プレースホルダ化された入力で別パラメータ実行が成功 / semantic step が凍結されていない(brief のまま)ことのレビュー確認。担当: opus(分類設計)→ sonnet(実装)。
- **関連**: HN-03(workflow-as-code は昇格先の第2形態)、AR-02(op レジストリから step 語彙を検証)。

### LC-03: 修復イベントの学習接続 — P2 / S

- **問題**: 修復成功時の diff は trace に残るが、**同じ失敗クラスの再発防止**に使われない(feedback-loop hints は error span 由来のみ)。
- **実装**: `attemptAutonomousRepair` 成功時に「失敗クラス(classifyError)→修復パターン」を KnowledgeHint として persist し、`buildRepairHints`(`adf-repair-agent.ts:214-269`)が次回同クラス修復時に注入。
- **受入**: 同一失敗クラス2回目の修復プロンプトに前回パターンが含まれる。担当: sonnet。

---

## 2. L2: LLM 判断配置ループ(どこで LLM に頼むか)

### 2.1 確立済みの型(再掲・正本参照)

- **蒸留→一点判断**: 決定論 op で観測を蒸留(`distill_dom`、上限 12,000 字)してから `llm_decide` で一点だけ判断。選択肢があるなら**選択>生成**(options 外は拒否、単一選択肢は LLM 呼び出しなし)— `libs/core/semantic-decide.ts:33-86`(AR-07)。
- **schema 強制委譲**: `delegateStructured<T>`(retry-on-mismatch、既定2回)— HN-02 **DONE**。
- **モデル/エフォート・ルーティング**: タスク単位 tier 解決 — MO-05 **DONE**。
- **品質最大化**: high リスク実装タスクは best-of-2 + judge、文書 deliverable は draft→refine — MO-07 **稼働中(opt-out)**。

### LC-04: AR-07 横展開の完遂 — P1 / M(= AR-07 残作業、本計画では追跡のみ)

android/terminal への `llm_decide` 展開、蒸留ヘルパの system/network 適用。正本は [AR-07](./AR-07_SEMANTIC_INLOOP_OPS.ja.md)。

### LC-05: 判断配置ルーブリックの正本化 + preflight lint — P1 / S

- **問題**: 「どのポイントで LLM に頼むか」の判断基準が AR-07/HN 系文書に分散し、pipeline 作者(人間・エージェント双方)が一貫して従える1枚の正本がない。
- **実装**:
  1. `knowledge/product/governance/llm-invocation-rubric.md` を新設。ラダー: **決定論 op で可能 → 選択肢化して `llm_decide`(選択>生成) → 生成が必要なら `delegateStructured`(schema 強制) → 品質クリティカルなら best-of-N + judge → 人間承認**。各段の判定条件(観測が蒸留可能か・選択肢が列挙可能か・出力が schema 化可能か・リスク tier)を明記。
  2. guardrails に lint 追加: `llm_decide` の直前に蒸留系 op がない場合 warning / options なし `llm_decide` に fallback 定義がない場合 warning(`adf-guardrails.ts` へ追加、error にはしない)。
- **受入**: rubric がワーカープロンプト(working-principles 注入)から参照可能 / lint が既存 pipelines 全件で false-positive ゼロ。担当: opus(rubric)→ sonnet(lint)。

### LC-06: 品質シグナル→redo の消費者接続(MO-07 残) — P1 / S

- **問題**: `evaluateSimulationQuality` の `poor` 判定は永続化されるが**消費者がいない**(`decision-ops.ts:1016,1023,1716,1732`)。「成功 = throw しなかった」のままの経路が残る。
- **実装**: `poor` 判定を (a) draft→refine の追加1パス、または (b) IL-04 の rework task 化のどちらかに接続(リスク tier で分岐)。上限は既存 `KYBERION_GOAL_LOOP_MAX_ROUNDS` に相乗りし新設しない。
- **受入**: poor 判定→redo 実行→再評価のテスト / 上限到達時に operator エスカレーション。担当: sonnet。

---

## 3. L3: 縮退防止ループ(stub へのサイレント縮退の遮断)

### 3.1 現状の正確な理解(調査確定)

- **実行中のプロバイダ障害は無音でない**: `FailoverReasoningBackend.runWithFailover`(`reasoning-backend.ts:511-555`)は warn ログ + プロバイダ demotion(auth 系は 6h)+ 全滅時 throw。**stub は failover 候補に入らない**。
- **無音経路は3つ**:
  1. **インストール時**: 選択モードのバックエンドが構築できない(鍵/CLI 欠落)と `logger.warn` のみで stub が residual 登録される(`reasoning-bootstrap.ts:493-509`)。以後 `getReasoningBackend()`(`reasoning-backend.ts:902-904`)は無音で stub を返す。
  2. **構造化 stub 出力**: `extractRequirements`/`decomposeIntoTasks`/`crossCritique` 等は schema 妥当な `[STUB]` オブジェクトを返し、`stubText` の envelope 警告(`:914-918`)は `delegateTask`/`prompt` のみ配線。ミッションが**構造ゲートを通過して偽成功**し得る。
  3. **`llm_decide` の null 縮退**: モデルエラーを warn ログのみで null に飲み込む(`semantic-decide.ts:82-85`)。設計意図(pipeline を落とさない)だが観測されない。

### LC-07: stub 汚染(taint)の伝播と完了ゲート — **P0** / M

- **実装**:
  1. stub バックエンドの**全メソッド**(構造化 extractors 含む)の返り値に `meta.stub_source: true` を付与し、trace event `reasoning.stub_served` を発火。
  2. ミッション完了ゲート(IL-04 の突合エンジン)と task-session close で、deliverable の系譜に stub_source があれば: `KYBERION_REASONING_BACKEND=stub` が明示されていれば通す(テスト用途)、そうでなければ**完了をブロックし needs_attention**。
- **受入**: 鍵未設定環境でミッションが「偽成功」せず、stub 明示環境では既存テストが全緑のまま。担当: sonnet。
- **関連**: ONB-01(オンボード時は解決済み。本タスクは**ランタイム側の防衛線**)。

### LC-08: 空チェーン検出の fail-loud 化 — **P0** / S

- **実装**: `_installReasoningBackendsCore` で「選択モードあり・チェーン空」の residual stub 登録時に、(a) baseline-check の report を `needs_attention` にする配線、(b) `notifyOperator` 1回通知(毎呼び出しではなくインストール時1回)。`KYBERION_ALLOW_STUB_FALLBACK=1` でのみ従来挙動。
- **受入**: 鍵を消した環境で baseline-check が needs_attention を返す / 明示 stub モードでは通知されない。担当: sonnet。

### LC-09: `llm_decide` 縮退の可観測化 — P1 / S

- **実装**: null 返却の理由を trace event(`semantic_decide.degraded`: model_error / option_rejected / cap_exceeded)として記録し、run summary に縮退カウントを表示。同一 pipeline 内で連続 N 回(既定3)の model_error 縮退は step failure に昇格するオプション(`on_degraded: fail`)を op スキーマに追加(既定は現行維持)。
- **受入**: 縮退カウントが run summary と operator packet に出る / `on_degraded: fail` の動作テスト。担当: sonnet。

---

## 4. L4: 人間フィードバックループ(却下→理由→改善→再実行)

### 4.1 現状の正確な理解(調査確定)

- 承認の却下 `note` は per-approval レコードの奥(`approval-store.ts:382`)にのみ残り、**監査イベント JSONL に載らず**(`:397-411`)、`enforceApprovalGate` は理由を読まずブロックするだけ。
- 成果物レビュー(SU-03)は verdict + comment を捕捉し v2 clone まで作るが、**comment→再生成の配線が未実装**(SU-03 Task 3.2/3.3 未了)。MO-07 の draft-refine/best-of-N は存在するのに呼ばれない。
- 自動学習ループ(trace error span → hints → knowledge、`feedback-loop.ts` + `knowledge-index.ts:428-436`)は稼働しているが、**人間の却下理由はこのループに一切入らない**。
- 機械由来のギャップは IL-04(DONE)が閉じている。**人間由来の却下だけが開いている**。

### LC-10: 却下理由の構造化捕捉 + ask-why — **P0** / S〜M

- **実装**:
  1. 承認却下イベント JSONL / trace に `note` を含める(`approval-store.ts:397-411` へ追加。PII/機密は既存 redaction を通す)。
  2. **ask-why**: surface(chronos deliverable-review UI・CLI・会話ブリッジ)で reject / request-changes の理由が空のとき、**一問だけ**「どこが期待と違いましたか」を聞き返す(選択肢: 内容が誤り / 期待と方向が違う / 品質不足 / スコープ過不足 / その他自由記述)。強制はしない(スキップ可)。選択肢化するのは学習側(LC-12)の dedup を決定論化するため。
  3. verdict スキーマに `reason_category` を追加(SU-03 の review entry と approval note の両方で共通語彙)。
- **受入**: 却下イベントに note/reason_category が入る / ask-why がスキップ可能で UI 3面(chronos/CLI/ブリッジ)に出る。担当: sonnet。

### LC-11: 理由→修正再実行(SU-03 Task 3.2/3.3 の実装) — **P0** / M

- **実装**:
  1. **request-changes**: `review_comment` + `reason_category` を **goal-diff** として構成し、IL-04 の rework task 生成(`goal-gap-r<round>-<n>` と同型の `review-gap-r<round>-<n>`)へ注入。文書系 deliverable は MO-07 draft-refine に directive として渡す。再生成物は既存の v2 版管理に載せ、**再レビューへ戻す**(自動 accept しない)。
  2. **reject**: 完了を undo し、mission を `validating` に戻す(IL-04 の `GOAL_GAP_REALIGN` と同じ状態機械を使う。新設しない)。
  3. ループ上限: `KYBERION_GOAL_LOOP_MAX_ROUNDS` を共用。上限到達時は operator へ「このタスクは往復では収束しません」エスカレーション。
- **受入**: request-changes → 修正版 v2 が自動生成され inbox に戻る E2E / reject → mission が validating に戻り rework task が生えるテスト / 上限到達エスカレーション。担当: opus(状態機械接続の設計)→ sonnet。
- **関連**: IL-05(会話上の「そうじゃない/やり直し」検知と completed 再オープン)は**別レーン**として残す。LC-11 は構造化 verdict 経由に限定し、IL-05 の実装が追いついたら同じ goal-diff 注入点に合流する。

### LC-12: 理由→学習(却下の再発防止) — P1 / S

- **実装**: 却下イベント(reason_category + note + 対象 deliverable の型)を `extractHintsFromTrace` の入力に追加し、`human_rejection` 種別の KnowledgeHint として persist。KM-03 の promotion queue に memory candidate としても投入(直接 HINTS.md を書かない。KM-03 の統治に従う)。同型却下(同 category × 同 deliverable 型 × 同 tenant)の 2 回目以降は、ワーカーの task brief に前回却下理由を注入。
- **受入**: 却下→hint 生成→次回同型タスクの brief に注入される統合テスト / KM-03 dedup を通ることの確認。担当: sonnet。

---

## 4.9 実装状況(2026-07-13, Wave 1 完了)

- **LC-08 実装済み**: `libs/core/reasoning-degradation.ts`(マーカー write/read/clear)+ bootstrap の残留 stub 経路で marker + `notifyOperator('ops_alert')`(`KYBERION_ALLOW_STUB_FALLBACK=1` で旧挙動)+ baseline-check が marker を読んで `needs_attention` 降格 + report に `reasoning_degraded` を出力。テスト4本緑。
- **LC-07 実装済み**: stub 全11メソッドの呼び出しを process-wide に記録(`getStubServedOps` / `resetStubServedOps` / `stubExplicitlyRequested`)。`reconcileCompletionStructurally`(task-session close と mission finish の共通路)が taint 検出時に `satisfied=false` + `reasoning_stub_served` gap + confidence≤0.2 を強制。明示 stub モードは免除。テスト6本緑。
- **LC-10 実装済み(一部残)**: 共有語彙 `rejection-reason.ts`(5カテゴリ+正規化)。承認却下の note + reason_category がイベント JSONL に載るよう修正(従来は nested workflow record 止まり)。deliverable review の entry / v2 clone metadata / inbox verdict に reason_category 貫通。chronos レビュー UI にスキップ可能な ask-why 1問(コメント空の reject / request-changes 時のみ表示)。approval-actuator は `reasonCategory` param を受理。**残**: CLI・会話ブリッジ面の ask-why(構造は API/store 側で受理済みのため、各 surface の1問 UI 追加のみ)。
- 検証: 対象スイート(approval 4ファイル34本 + 新規3ファイル12本 + reconciliation/task-session)緑、chronos-mirror-v2 Next.js ビルド成功。

## 4.10 実装状況 追記(2026-07-13, Wave 2〜3 の一部完了)

- **LC-11 実装済み**: `libs/core/review-reentry.ts`(governed 再突入キュー: enqueue / listPending / markProcessed + `buildReviewGapText`)。chronos の deliverable-review route が非 accept verdict でキュー投入(best-effort)。**mission finish は pending 再突入要求を completion reconciliation の gaps に合流**させ、既存 IL-04 goal loop が implementer+reviewer の rework task(`goal-gap-r<n>`)を生成・要求を processed 化(上限 `KYBERION_GOAL_LOOP_MAX_ROUNDS` 共用・超過は operator エスカレーション)。完了済みミッションは **`mission_controller review-reenter <ID>`**(round カウンタ共用、オペレータ明示実行のため上限なし)。テスト: review-reentry 4本 + mission_controller 特性化49本 + scripts/refactor 91本 + tsc 緑。
- **LC-01 実装済み**: `attemptAutonomousRepair` の前段に決定論カスケード(`tryRepairJson` + 修復後 validate)。パース不能な機械的破損は **LLM 呼び出しゼロ**で修復、パース可能な意味的破損のみ LLM へ。テスト2本追加(既存4本と共に緑)。
- **LC-12 実装済み(v1)**: 再突入要求の enqueue 時に `human-rejection:<category>` の KnowledgeHint を persist(runtime hints → knowledge index 自動取り込み経由で次回同型作業の検索に乗る)+ KM-03 promotion queue へ memory candidate 投入(confidential tier、統治付き)。**残(v2)**: ワーカー brief への同型却下履歴の明示注入(現状は knowledge 検索経由)。
- **未着手**: LC-02(pipeline:promote — 本計画の中核、次スライス推奨)、LC-05(rubric + lint)、LC-06(poor→redo)、LC-09(llm_decide 可観測化)、LC-03、LC-04(AR-07 残の追跡)、LC-10 残(CLI/会話ブリッジの ask-why)。

## 4.11 実装状況 追記(2026-07-13, 全タスク完了 — LC-04 は AR-07 で追跡)

- **LC-02 実装済み**: `pnpm pipeline:promote --input <adf> [--name] [--trace] [--dry-run] [--no-llm] [--force]`(`scripts/pipeline_promote.ts`)。source preflight → LLM 1問のアドバイザリ(placeholder 化・semantic step フラグ。stub/--no-llm では verbatim 昇格 + note)→ 出自 stamping(`promotion` キー)→ 再 preflight → `pipelines/<slug>.json` 書き出し + README カタログ行追記。**実 ADF で E2E 検証済み(昇格→ run_pipeline 実行green)**。run_pipeline はアドホック ADF の成功時に昇格サジェスト1行を表示。`ecosystem_architect` に `pipelines/` write 権限を追加(registry 生成と同一ロール)。残: 同型 intent 反復数(≥3)による自動候補提示は intent-contract-memory 連携として次スライス。
- **LC-05 実装済み**: 正本 `knowledge/product/governance/llm-invocation-rubric.md`(6段ラダー+判定質問+アンチパターン)。guardrails に warn lint 2種(`llm-decide-without-distill` / `llm-decide-without-fallback`、既存 pipelines に llm_decide 使用なしのため false-positive ゼロ)。strategist の working principles にラダー参照を注入。
- **LC-06 実装済み**: `simulateAll` / `simulateAllEnsemble` の redo 後もなお poor / divergent の場合に ops alert でオペレータへエスカレーション(dedupe 付き)。
- **LC-09 実装済み**: semantic-decide に縮退レジストリ(model_error / option_rejected / empty_decision + 連続 model_error カウンタ)。`llm_decide` は `<export_as>_degraded` を export し、`on_degraded: fail` + `degraded_threshold`(既定3)で連続 model_error を step failure に昇格可能。run_pipeline が縮退サマリを表示。残: operator packet への集計表示。
- **LC-03 実装済み**: 検証済み LLM 修復の成功時に `repair:<category>:<op>` hint を persist(adf-repair カテゴリ、topic dedup)し、次回同クラス修復のプロンプトに直近3件を注入。
- **LC-10 残の実装**: chronos **承認キュー**の却下にも ask-why(従来は固定 note のみで理由ゼロ)。reason_category が approval_decision → イベントストリームまで貫通。真の残り: 会話ブリッジ(Slack/iMessage)上の対話型 ask-why — IL-05(修正意図の検知・再突入)と同レーンで扱うのが適切。
- 検証: 対象スイート緑 + repo tsc 緑 + chronos build 緑 + `pipeline:promote` 実機 E2E。

## 4.12 実装状況 追記(2026-07-13, フォローアップ接続4点)

- **LC-12 v2**: ワーカー brief(`buildTaskExecutionPrompt`)に「Recent human-rejection lessons」節を注入(`readHintsByCategory('human-rejection')` 直近3件)。context pack の pruning 予算外の ephemeral 行として実装。
- **LC-09 残**: 縮退カウントを `active/shared/runtime/feedback-loop/semantic-degradations.json` に永続化(run_pipeline)し、operator packet の status report が週次集計 finding(`semantic-degradations`)+ metric を表示。
- **LC-02 残**: アドホック ADF の成功回数を台帳化(`promotion-candidates.ts`)。3回で run_pipeline が昇格推奨を warn 表示、operator packet に `promotion-candidates` finding。intent-contract-memory には同型集計 API が無いため、決定論のパス単位集計を採用(調査で確認)。
- **LC-10 残(ブリッジ)**: Slack 承認却下に ask-why **ボタン**(自由文の会話状態機械を避け、`slack_approval_askwhy` action で決定論的に受理)。決定後の理由付与は `annotateApprovalRejectionReason`(approval-store)が `rejection_reason_captured` イベントとして追記。iMessage/Telegram への同型展開と会話文中の修正意図検知(IL-05)が真の残り。
- 検証: worker 22本 / approval-reason 3本 / slack-ui + bridge + orchestrator 31本 緑、repo tsc 緑。
- ナレッジ正本: [`knowledge/product/architecture/loop-closure-machinery.md`](../../../knowledge/product/architecture/loop-closure-machinery.md)(初見モデル向け実装地図)。

## 5. 実施順序と依存

```
Wave 1(P0・並行可): LC-07, LC-08(縮退遮断)/ LC-10(理由捕捉)
Wave 2(P0):        LC-11(理由→再実行。LC-10 に依存)/ LC-02(昇格ツール)
Wave 3(P1):        LC-01, LC-05, LC-06, LC-09, LC-12(LC-10 に依存)
Wave 4(P2/追跡):   LC-03 / LC-04(AR-07 残の追跡)
```

- L3(縮退遮断)を最初に置く理由: L1/L2/L4 のループはすべて LLM 判断を含む。**判断の供給源が偽物でないことが全ループの前提**。
- LC-11 は本計画の最大価値(人間の却下が自動で修正版になる体験)。LC-10 が先行必須。
- 各タスクは独立ブランチ/パッチ単位で完結させ、`pnpm lint && pnpm test:unit` を各コミットで通す(README §6 の共通規約に従う)。

## 6. 受入の全体条件(計画レベル)

1. **L1**: 一回きり成功→`pipeline:promote` 1コマンド→preflight 緑の再実行可能 pipeline、が10分以内で完了する。
2. **L2**: pipeline 作者(人間/エージェント)が rubric 1枚で「この判断はどの段か」を決められ、lint が逸脱を警告する。
3. **L3**: 鍵未設定・CLI 欠落・実行中全滅のどのケースでも「無音で stub の結果が成果物になる」経路が存在しない(明示 stub モード除く)。
4. **L4**: 人間が reject / request-changes した成果物のうち、理由付きのものは自動で修正版が inbox に戻り、同型却下の再発率が観測可能に下がる(却下イベントに category が付くため計測可能になる)。

## 7. 既存計画との対応表

| 本計画   | 依存/包含する既存 ID(状態)                      | 関係                                                   |
| -------- | ----------------------------------------------- | ------------------------------------------------------ |
| LC-01    | AR-01(PARTIAL: Phase C 残)                      | 修復カスケードの前段挿入。Phase C とは独立             |
| LC-02    | HN-03(DONE)、AR-02(DONE)                        | workflow-as-code / op レジストリを昇格先・検証に利用   |
| LC-04    | AR-07(PARTIAL)                                  | 残作業の追跡のみ(正本は AR-07)                         |
| LC-05    | AR-07、HN-01/02、MO-05                          | 分散した判断基準の1枚化                                |
| LC-06    | MO-07(PARTIAL)                                  | §14 記載の残ギャップの実装                             |
| LC-07/08 | ONB-01(DONE)                                    | オンボード解決済み問題の**ランタイム防衛線**           |
| LC-10/11 | SU-03(DONE だが Task 3.2/3.3 未了)、IL-04(DONE) | SU-03 残タスクの実装 + IL-04 状態機械への合流          |
| LC-12    | KM-03(DONE)、IL-05(PARTIAL)                     | KM-03 統治経由での学習投入。IL-05 は別レーンで合流予定 |
