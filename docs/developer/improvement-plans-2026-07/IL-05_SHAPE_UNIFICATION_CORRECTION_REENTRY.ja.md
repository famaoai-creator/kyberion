# IL-05: shape 決定の一元化と修正の再突入

> 優先度: P2 / 規模: M / 依存: IL-01/IL-02 / 関連: UX-04(承認・確認)、AC-02(未処理意図)
>
> **なぜ重要か**: 「どう実行するか(shape)」が複数権威で食い違い、ユーザーの「そうじゃない」が文脈を失って再突入する — どちらも intent→result の一貫性を静かに損なう。

## 背景と課題

### shape 決定が 2〜3 の未統合権威で行われる

- `resolveIntentResolutionPacket` の `selected_resolution.shape`(決定論スコアリング、`intent-resolution.ts:600,642`)
- 実際に route handler を選ぶ `resolveSurfaceIntent(...).routeFamily`(`surface-runtime-orchestrator.ts:1565,1583,1596,1621`)
- IntentContract 最終の LLM コンパイル `resolution.execution_shape`(`intent-contract.ts:1448`、fallback `:1462-1471`)

これらは独立計算で、`chooseExecutionIntent`(`intent-resolution.ts:695`、"GAP1: resolver convergence")は intent_id は収束させるが **shape は収束させない**。dispatch を駆動する `routeFamily` が契約に書かれた `selected_resolution.shape` と食い違い得るのに、その不一致はどこにも surface されない。

### 修正の再突入がコンテキストを失う

- task-session のスロット充填は前方向のみ: 修正発話は次の空きスロットに直書き(`surface-runtime-orchestrator.ts:228,255`)で、「違う/やり直し」検知もバックトラックも無い。
- clarification パケット経路は pending intent を**永続化しない**(`question-resolver.ts` は resolve 系ビルダーのみ、save/store 無し)。再突入は `threadContext` 文字列連結 + フル再コンパイル(`:1653,1663`)頼み。
- 納品後の修正は、`getActiveTaskSession` が `completed` を除外する(`task-session.ts:1096`)ため前のタスクセッションを再利用できず、前の契約と無関係な新規コンパイルから始まる。

## ゴール(受入条件)

1. shape 決定に**単一の正準**が定まり、他の推定との不一致が `intent_compilation.completed` トレース(`intent-contract.ts:1346`)に記録される。dispatch は正準 shape に従う。
2. 「そうじゃない/違う/やり直し」等の**修正意図が検知**され、前方向スロット直書きでなくバックトラック(該当スロットの再質問)に入る。
3. clarification/pending intent が**永続化**され、再突入時にフル再コンパイルでなく保存済み文脈から再開できる。
4. 納品後の修正が、前の(completed)タスクセッション/契約を**再オープンして継承**でき、相関スレッド(IL-02)が繋がったまま続く。

## 実装タスク

### Task 1: shape 正準化 — `claude-sonnet-4`

1. 3 つの shape 源(`selected_resolution.shape` / `routeFamily` / LLM `execution_shape`)の関係を整理し、**正準を 1 つ**に定める(推奨: 決定論 `selected_resolution.shape` を基礎に、LLM は不確実時の補正に限定。dispatch の `routeFamily` は正準から導出)。
2. `chooseExecutionIntent`(`intent-resolution.ts:695`)を shape も収束させるよう拡張し、不一致を `intent_compilation.completed` トレースに `shape_disagreement` として記録。
3. dispatch(`surface-runtime-orchestrator.ts:1561` の handler 選択)が正準 shape を使うことを確認。
4. テスト: 決定論と LLM が食い違うケースで正準が一貫すること、不一致がトレースに残ること。

### Task 2: 修正意図の検知とバックトラック — `claude-sonnet-4`

1. `libs/core` に修正検知(「違う」「そうじゃない」「やり直し」「no, not like that」等、locale 別・決定論パターン)を追加。UX-04 の受理語パーサと同じ場所に置く。
2. task-session スロット充填(`surface-runtime-orchestrator.ts:228,255`)で、修正検知時は次スロット直書きでなく「直前に埋めたスロットの再質問」にバックトラック。どのスロットを直すかが曖昧なら明確化質問。
3. テスト: スロット充填中の修正発話がバックトラックすること。

### Task 3: pending intent の永続化 — `claude-sonnet-4`

1. clarification パケット発行時に pending intent(compiled contract + 未解決スロット + 相関 ID)を永続化する store を追加(`question-resolver` は保存しないので、`libs/core/pending-intent-store.ts` を新設、runtime 領域)。
2. 再突入時は `threadContext` 文字列連結のフル再コンパイル(`:1653`)でなく、保存済み contract を復元して差分だけ適用。
3. TTL(未完了 pending は KM-01 の janitor で回収)。
4. テスト: clarification → 中断 → 再突入で保存文脈から再開。

### Task 4: 納品後修正の再オープン — `claude-sonnet-4`

1. 直近 completed タスクセッションへの修正発話(相関 ID or 直近性で判定)を検知したら、`getActiveTaskSession`(`task-session.ts:1096`)とは別に「completed を再オープンして継承」経路を設ける。前の outcome contract・成果物・相関スレッド(IL-02)を引き継ぐ。
2. 再オープンは監査記録し、IL-04 のクロージングで「前回の Z を W に修正」と提示。
3. テスト: 納品後修正が前契約を継承して続くこと。

## リスクと注意

- 修正検知の誤爆(正常発話を修正と誤判定)は会話を混乱させる。決定論パターンは高信頼な語のみにし、曖昧時は明確化質問に落とす(勝手にバックトラックしない)。
- 完了セッションの再オープンは「いつまで遡れるか」を限定しないと際限がない。相関 ID 一致 or 直近 N 分/最新1件に限定。
- shape 正準化は dispatch 経路の挙動を変え得る。まず不一致を**記録するだけ**(正準は現行 routeFamily 維持)で観測し、乖離の実態を見てから正準を切り替える 2 段構え。
