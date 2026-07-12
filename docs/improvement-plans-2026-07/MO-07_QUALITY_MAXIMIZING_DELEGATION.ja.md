# MO-07: 品質最大化タスク移譲 — 「完了」でなく「最高の成果物」を出す

> 優先度: P1 / 規模: L(フェーズ分割) / 依存: MO-02(ゲート)、MO-04(コンテキスト)、MO-05(モデルルーティング) / 関連: SU-03(レビュー/反復の UI)
>
> **参考にしたハーネス原則(Fable 5)**: 品質は「N 個生成して審判で選ぶ(judge panel / best-of-N)」「敵対的に反証させる」「下書き→批評→改稿」「低品質なら上位モデルで再試行」で上げる。既定は単発でよいが、高難度・高リスクの成果物にはこれらを効かせる。**既に repo 内に眠っている品質機構を起動する**のが最短。

## 背景と課題

repo には**2つの断絶した世界**がある:

- **decision/simulation 領域**(`wisdom-actuator/decision-ops.ts` + `structured-reasoning`): 本格的な品質機構が存在 — 多ペルソナ発散(`divergePersonas`)、相互批評(`crossCritique`、生存/棄却つき)、分岐 fork/simulate、**best-of-N アンサンブル(`simulateAllEnsemble`、runs≥2)**、収束スコアリング(`evaluateEnsembleConvergence`)、**決定論的品質ルーブリック(`evaluateSimulationQuality`、severity ok|warn|poor)**。real 実装済み(stub はオフライン fallback のみ)。
- **deliverable 生成領域**(mission work-item dispatch、media 生成、content、action-item 自己実行): **単発委譲 + 品質評価ゼロ**。`delegateTask(instruction, context): Promise<string>`(`reasoning-backend.ts:344`)は 1 プロンプト→1 文字列で、N も候補配列も judge も改稿ハンドルも無い。成功 = 「呼び出しが throw しなかった」(`super-nerve/index.ts:116`、`decision-ops.ts:1426`)。

**部分的 dead-end**: severity は一部で消費される(`uncertainty_gate` が convergence_severity を gate verdict に反映、`decision-ops.ts:2750` — 2026-07-03 レビュー訂正)。しかし `evaluateSimulationQuality` のルーブリックは severity を計算し、コメント(`decision-ops.ts:1849`)自身が poor = 「より強いモデル/小さいスコープで再実行せよ」と言うのに、**その品質 severity を consume して deliverable の redo/escalation を起こす consumer は無い**(`:1016,1023,1716,1732` で永続化されるだけ)。品質機構が judgment 支援に作られ **artifact 品質の redo には配線されていない**、という二世界テーゼは成立する。

## ゴール(受入条件)

1. **休眠している品質シグナルを起動**: `evaluateSimulationQuality`/`evaluateEnsembleConvergence` の `poor` を consume し、より強いバックエンド/大きい予算で再実行する consumer が動く。
2. **成果物品質契約**: decision 領域のルーブリック形(hard/soft チェック + severity)を `evaluateDeliverableQuality(kind, artifact)` として一般化し、種別別ルーブリック(doc/deck/code/media)を持ち、MO-02 の review gate に**内容品質ゲート**として接続。
3. **best-of-N + judge**(高リスク成果物のみ): `delegateBestOf(instruction, { n, judge })` で K 候補生成 → ルーブリック judge で採点 → 勝者 + 根拠を返す。`risk: high_stakes`/`strict` モードに限定(単純タスクは単発維持)。
4. **敵対的レビュー**: `crossCritique` の機構を**産出成果物**に向け、reviewer が blocking findings を出す → ゲート verdict `concerns/blocked` → redo。
5. **draft→refine**(content/media): media LLM zone に下書き→自己批評→改稿(1〜2 pass 上限)を追加。
6. **品質ランクされた再利用**: `buildReusableArtifactHints`(`mission-context-pack.ts:795`)の recency ソートを品質/outcome スコアに置換(最新でなく最良の先行例で seed)。

## 実装タスク

### Task 1: 品質 severity の consumer(最小・即効)— `claude-sonnet-4`

1. `evaluateSimulationQuality`/`evaluateEnsembleConvergence` の結果を読む consumer を追加: `poor` なら MO-05 のモデルルーティングで 1 段上の tier に上げて再実行(上限 1 回)。ルーブリックコメント(`decision-ops.ts:1849`)が既に処方している挙動を実装するだけ。
2. MO-02 の verify→redo エッジとして接続(ゲート機構は再利用、重複しない)。
3. テスト: poor severity → 上位 tier で再実行、ok → そのまま。

### Task 2: 成果物品質契約の一般化 — `claude-sonnet-4`

1. `SimulationQualityReport`(`decision-ops.ts:1852`)の hard/soft + severity 形を `libs/core/deliverable-quality.ts` の `evaluateDeliverableQuality(kind, artifact): QualityReport` として一般化。種別別ルーブリック(doc: 見出し構造/長さ/要求網羅、deck: スライド数/一貫性、code: ビルド/lint/テスト通過、media: 生成成否/仕様一致)。
2. `mission-review-gates.ts` に `DELIVERABLE_QUALITY` ゲートを追加(`checkArtifactBundleGate` `:176` と並ぶ内容ゲート)。verdict は既存の `ready|concerns|blocked` モデルを使用。
3. code 種別は IP-03 のテスト/lint 実行、SA-02 の実行境界を再利用。テスト: 各種別の品質判定。

### Task 3: best-of-N + judge(高リスク限定)— `claude-sonnet-4`

1. `reasoning-backend` に `delegateBestOf(instruction, opts: { n, judge, context })` を追加(単発 `delegateTask` のラッパ)。K 候補を並列生成(MO-03 の並列基盤)→ judge プロンプト(ルーブリック駆動)で採点 → 勝者 + rationale。アンサンブルランナー(`decision-ops.ts:1684`)が fan-out+集約の実装テンプレート。
2. 発動条件: `risk_profile: high_stakes` または review mode `strict` のタスクのみ(absorption plan の「単純タスクは単純に実行」`:567` を尊重)。n は既定 3。
3. コスト影響が大きいので OP-01 の spend-guard と連動(予算内でのみ best-of-N)。
4. テスト: 高リスクで best-of-N 発動・低リスクで単発、judge の勝者選択。

### Task 4: 敵対的レビューと draft-refine — `claude-sonnet-4`

1. `crossCritique`(`structured-reasoning`)の変種を産出成果物に向け、reviewer エージェントが「この成果物が受入条件を満たさないケース」を探す(MO-02 Task 3 の独立レビューと統合 — 重複させず、MO-02 のレビュー経路にルーブリック採点を足す形)。blocking findings → Task 2 のゲート → Task 1 の redo。
2. media LLM zone(`media-document-helpers.ts:48`)に下書き→ルーブリック自己批評→改稿(1〜2 pass 上限)を追加。長文 doc/deck の品質向上。
3. テスト: 敵対レビューで欠陥検出→redo、draft-refine で改稿。

### Task 5: 品質ランク再利用 — `claude-sonnet-4`

1. `ArtifactOwnershipRecord` に品質フィールド(最終ゲート verdict / operator 修正率 / 昇格状態)を追加。
2. `buildReusableArtifactHints`(`mission-context-pack.ts:793-796`)の recency ソートを品質スコアソートに置換。MO-04 の worker コンテキストが**最良の先行例**で seed される。
3. テスト: 品質順で最良例が選ばれること。

## リスクと注意

- best-of-N・敵対レビュー・draft-refine は**トークンコストを数倍にする**。すべて高リスク/strict 限定 + OP-01 の予算連動を厳守。単純タスクの単発経路を殺さない(品質と効率のバランス)。
- ルーブリックの過剰厳格は正常な成果物を「poor」と誤判定し無駄な redo を生む。まず warn(採点を記録するが redo しない)で観測 → 精度確認 → redo/escalation 有効化。
- judge/reviewer も LLM なので誤判定する。redo は上限付き(無限ループ防止)、判定に confidence を添え、low は人間レビュー(SU-03)へ回す。
- stub backend では品質機構が形骸化。テストは judge/critique 応答を fixture 注入。

## 実装状況(2026-07-07)

最小起動済み(E2E-03 Task 5): `risk === 'high' | 'high_stakes'` の implement 系タスクは best-of-2(最小実装優先 vs 堅牢性優先)+ 独立 judge で採択される(`mission-orchestration-worker.ts` の `obtainBestOfTaskResultResponse`)。敗者は `evidence/alternatives/` に保存、judge 判定は task イベント `best_of_judged`(cost_multiplier: 2)で記録。`KYBERION_BEST_OF_N=0` で無効化。draft-refine / 敵対レビュー全面適用は残余。

## 実装状況 追記 (2026-07-12)

- **Task 4.2 実装(draft→refine エンジン)**: `libs/core/draft-refine.ts` — doc/deck の下書きを決定論的ルーブリック(`evaluateDeliverableQuality`)で採点し、findings を明示した改稿プロンプトで再生成(**上限2パス**、ルーブリック改善が無ければ即終了、悪化時は前稿を保持、refine 失敗でも原稿は失わない)。critique 関数は注入可能で stub 環境でもテストが実挙動を固定(計画 Task 4.3 の fixture 方針どおり)。テスト5本。
- **worker 配線済み(同日)**: 高リスク(high/high_stakes)× 実装系ロール × テキスト文書 deliverable(.md/.txt)のタスクは、受入ゲート前に 1 パスの refine を適用(改善時のみ上書き + `draft_refined` イベントで cost_multiplier 記録、失敗はブロックせず warn)。`KYBERION_DRAFT_REFINE=0` で無効化。tier 昇格連動の再実行は MO-05 ルーティングと合わせて設計要。
- **task-session 配線済み(同日)**: `claude-task-session-executor` の document 出力(report_document / document_generation)に保存前1パスの refine を接続(`maybeRefineDocumentOutput`)。800字未満はコスト対効果でスキップ、失敗・悪化時は原稿維持、改善時のみ履歴に記録。browser 出力は対象外。計画 Task 4.2 が挙げた media LLM zone(`media-document-helpers.ts`)は現状 llm_zone 宣言のみで LLM 起草実装が存在しないため、実在する成果物生産経路(worker + task-session)への配線をもって Task 4.2 の適用を完了とする。
