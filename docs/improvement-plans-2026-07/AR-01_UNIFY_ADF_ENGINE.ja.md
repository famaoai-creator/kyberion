# AR-01: ADF 実行エンジンの統合 — 3つの非互換エンジンを1つに

> 優先度: **P0**(AR 系の土台) / 規模: L(段階分割必須) / 依存: なし / 関連: IP-05(CLI runner)、MO-03/HN-03(並列 op)、IP-12(実行モード)
> **検証(2026-07-03, Fable)**: 3エンジンの実在を確認 — `scripts/run_pipeline.ts`(`runSteps`)、`libs/actuators/orchestrator-actuator/src/super-nerve/index.ts`(`handleCoreAction`)、`libs/actuators/*/…-pipeline-helpers.ts`(`executePipeline`)。
> **進捗(2026-07-07)**: `libs/core/src/pipeline-engine.ts` に汎用 `executeAdfSteps` を追加し、`file-actuator` と `network-actuator` の pipeline ループをそこへ委譲し始めた。共通 runner のパイロットとして nested control と context 解決の回帰テストを追加済み。

## 背景と課題

「ADF パイプライン」は**3つの分岐したエンジン**のいずれかで実行され、各々が独自の制御フロー方言・`resolveVars`・`evaluateCondition`・dispatch・autonomous-repair を持つ。同じ ADF がランナー次第で**別の意味論**になる。

| エンジン                   | 制御 op                                                       | dispatch                                                    | vars/condition              |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------- |
| `run_pipeline.ts:runSteps` | `core:if/foreach/include/wait/transform`(while/parallel なし) | in-process `await import()`                                 | canonical(`logic-utils.ts`) |
| super-nerve `index.ts:30`  | `core:if/while/call/set`(foreach/include/transform/wait なし) | **subprocess** `safeExec(node, actuator, --input tmp.json)` | **local 再実装**(劣る)      |
| per-actuator(×11)          | `if/while` のみ                                               | in-process switch                                           | canonical(import)           |

- **同一 ADF が壊れる**: `core:foreach`/`core:include`(26テンプレが include 使用)は super-nerve では `Unknown core action`(実測: super-nerve は `core:if` 等を持たず未知 op を throw)。逆に `core:while` は run_pipeline で動かない。
- **super-nerve の local `resolveVars`/`evaluateCondition` は機能が劣る**(`{{var|default}}`・`{{@domain:path}}`・`env.` 非対応、条件は exists/not_empty/eq/gt のみ)。
- **op ごとに subprocess を起動**(temp JSON 往復)= 性能シンク + 全アクチュエータが CLI-runner ボイラープレートを抱える原因(IP-05 と連結)。
- **autonomous-repair が2重**(run_pipeline と super-nerve に別コピー、挙動が分岐)。

## ゴール(受入条件)

1. **正準エンジンを1つに**(`runSteps`)。super-nerve と per-actuator の step ループは、正準エンジンに op-handler map を渡す**薄いアダプタ**になる。
2. 制御 op(if/foreach/while/include/wait/transform)と vars/condition の意味論が**全経路で一致**(canonical `logic-utils`)。
3. super-nerve の op 毎 subprocess を廃し、in-process dispatch に(性能改善 + ボイラープレート削減、IP-05 と協調)。
4. autonomous-repair を単一実装に統合。
5. 既存の全テンプレ(99 + fragments)が新エンジンで**回帰なく**動く(golden で確認)。

## 実装タスク

### Task 1: 正準エンジンの抽出と契約定義 — `claude-opus`(設計)

1. `runSteps`(`run_pipeline.ts:321`)を `libs/core/adf-engine.ts` として抽出し、`executeAdfSteps(steps, { opHandlers, resolveVars, evaluateCondition, bounds })` の形にする。制御 op・vars・condition は canonical `logic-utils` を単一ソースに。
2. super-nerve と per-actuator の現状挙動差(制御 op・subprocess・repair)を洗い、**互換のための移行表**を本文書末尾に作る。while/parallel を正準に含めるか(HN-03 と協調)を決定。
3. 段階移行計画(どのランナーから薄アダプタ化するか、golden での回帰確認点)を定義。

### Task 2: per-actuator ループのアダプタ化 — `claude-sonnet-4`(1件でパターン確立)→ `claude-haiku`(横展開)

1. file-actuator の `executePipeline` を正準エンジン呼び出し + op-handler map に置換(パイロット)。golden で回帰確認。
2. 残り10アクチュエータを同パターンで横展開(1件ごとに該当テスト緑)。IP-05 の CLI runner 共通化と同時に進めると重複作業を避けられる。

### Task 3: super-nerve の私製エンジン廃止 — `claude-sonnet-4`

1. super-nerve(`orchestrator-helpers`/`super-nerve/index.ts`)の local `resolveVars`/`evaluateCondition`/repair/subprocess dispatch を削除し、正準エンジン + in-process dispatch へ委譲。`core:call`↔`core:include`、`core:set` の意味論を canonical に統一(param 名の差 `path`↔`fragment` も解消、AR-04 と協調)。
2. subprocess 依存の除去で性能/テンプレ互換を確認。

### Task 4: autonomous-repair 統合 — `claude-sonnet-4`

- `run_pipeline.ts:632` と super-nerve の repair を1実装に統合。SA-02 のガードレールと整合(repair が .env/authority を無承認で書き換えない、AO-03/SA-05 と連携)。

## 実装状況 (2026-07-06)

- **進行中(Task 2/3 の土台)**: `libs/core/adf-engine.ts` を新設し、capture / transform / apply / control の共通 step runner を切り出した。`file-actuator` と `super-nerve` はこの runner を使う薄いアダプタへ寄せ、制御フロー・step budget・自動修復の共通化を進めた。残りは `run_pipeline.ts` と golden 回帰の確認。
- **横展開1件目(2026-07-11)**: `network-actuator` の私製ループを `executeAdfSteps` へ移行(file-actuator パターン踏襲)。意味論統一に伴う意図的変更1点: 旧ループはネスト制御(`if`/`while` 配下)の失敗を握りつぶして `res.context` を採用していたが、正準化で fail-propagate に統一(AR-06 の no-silent-failure 準拠)。actuators 全46ファイル/553テスト緑。**横展開2件目(同日)**: `code-actuator` も移行。traceCtx の per-step span はアダプタ側の handler ラップで維持(エンジン非改変、`code:<type>:<op>` の命名互換)。実装時の学び: capture/transform/apply handler は 4引数 `(op, params, ctx, resolve)` で runSteps を取らない(5引数で書くと resolve が undefined になり静かに壊れる — テストが検出)。**残りの私製ループ**: modeling / system / wisdom / browser の4アクチュエータ。
- **横展開完了(2026-07-12)**: 残り4件(modeling / system / wisdom / browser)+ 棚卸しから漏れていた5件目の **media** を移行し、**アクチュエータ側の私製 step ループは全廃**。移行に必要だったエンジン拡張2点:
  - **`on_error` 回復のエンジン内蔵**: browser / media が個別に持っていた `handleStepError`(skip / abort / fallback)呼び出しを `executeAdfSteps` の catch パスへ移設。fallback サブパイプラインも同エンジンで実行されるため、失敗は伝播し(AR-06)、step budget にも計上される。`PipelineStepResult` に `'recovered'` ステータスを追加(`derivePipelineStatus` は failed のみ見るため互換)。
  - **step フック(`beforeStep`/`afterStep`)**: browser の per-step trace span・screenshot artifact・action-trail イベント、media の span 命名(`media:<type>:<op>`)をフックで注入。フックはネスト step(control 配下・on_error fallback)にも発火するため、従来トップレベルのみだった span がネストにも付く(改善として意図的)。
  - 意図的な意味論変更(media): 旧ループは step budget を受け取るだけで未執行だった → エンジンで実際に執行(メディア処理は長時間になり得るため timeout デフォルトは 60s でなく 10 分)。未知の control op は静かに無視 → throw に統一。`'sink'` type と `media:` op prefix は正規化アダプタで吸収(`on_error.fallback` 配列へも再帰適用。`on_error.ref` 経由の fallback に sink step が含まれるケースのみ未対応の既知エッジ)。
  - 残フェーズ: `run_pipeline.ts` の委譲、golden 回帰(`check:golden`)、自動修復の統一。
- **Task 3 完了: super-nerve の op 毎 subprocess dispatch を廃止(2026-07-12)**: `dispatchToActuator` の「temp ADF JSON を書き `node <built entry> --input` を spawn し、context_path 経由で結果を回収」する経路を、built entry の動的 import(entry 毎キャッシュ)+ `handleAction({action:'pipeline',...})` の直接呼び出しに置換。結果 context から `context_path` 等の内部キーを剥がして親 ctx にマージ(旧挙動と同じ契約)。テストは `actuatorModuleLoader` seam の stub でエルメチックに(dist を import しない)。検証: orchestrator 30 テスト緑、全 actuator 46/554 緑、dist 経由の実 dispatch E2E スモーク(file:read_file)緑、golden 緑。super-nerve の local resolveVars/evaluateCondition は既に canonical 化済みだったため、これで Task 3 は完了。残: Task 4(autonomous-repair の run_pipeline / super-nerve 2重実装統合)と run_pipeline 本体の委譲。
- **golden 回帰(2026-07-12)**: PR #494 マージ後の main で `pnpm run check:golden` 緑(2 パイプライン)。
- **Task 4 完了: autonomous-repair の統合(2026-07-12)**: run_pipeline / super-nerve が別々に持っていた `attemptAutonomousRepair` を `libs/core/autonomous-repair.ts` に一本化(request オブジェクト形式: step / failure / pipelinePath / policy / validate フック / logPrefix)。**意図的改善**: AO-03 §4 のセンシティブカテゴリ fail-closed(permission/auth/config/env → 修復せず ops-alert へエスカレーション)は従来 run_pipeline のみ実施で super-nerve は無防備だった → 統合により全ランナーで強制(SA-02 整合)。修復後検証は `validate` フックで caller が注入(run_pipeline は `readValidatedWorkflowAdf`)。core 単体テスト4本 + 両 caller のスイート緑・golden 緑。**AR-01 の残は run_pipeline 本体ループの委譲のみ**(flatten results・attempt/retry・before/after hooks・parallel_foreach 等の意味論差があるため独立スライスとして設計が必要)。
- **run_pipeline 意味論パリティ(2026-07-12)**: 本体ループの完全委譲は上記の意味論差のため独立設計として残すが、正準エンジンとの**意味論ギャップ2点を先行解消**: (1) schema にありながら未執行だった `options.max_steps` / `timeout_ms` を執行(明示指定時のみ — 長時間パイプラインの既定挙動は不変。ネスト含む flatten 計数を `_budgetState` で共有)。(2) step レベル `on_error`(skip/abort/fallback、`handleStepError` 共有実装)をサポート — 従来アクチュエータ内 step のみ有効で pipeline レベルでは無視されていた。作者明示の on_error が autonomous repair より優先。fallback 結果は runSteps 慣例どおり flatten。`RunStepResult` に `'recovered'` 追加。テスト +4(36本緑)、golden 緑。**これにより run_pipeline 完全委譲は「性能・保守都合のリファクタ」となり、意味論の分岐は解消**。
- **重複エンジンの一本化(2026-07-12、CI が検出)**: `libs/core/index.ts` が旧パイロット版 `executeAdfSteps`(`src/pipeline-engine.ts`)を**明示 re-export** しており、明示 export は `export *`(adf-engine)より優先されるため、移行済みアクチュエータは実は旧版で動いていた(hooks 引数は型不一致)。旧版を削除し、旧版のみの機能(`label` / `resolveVars` オプション)は正準エンジンへ吸収。**教訓2点**: (1) 同名 export の重複は明示 export が勝ち、静かに実装がすり替わる — 正準化では旧シンボルを必ず削除する。(2) root `tsconfig.json` は `scripts/presence/satellites` のみで `libs/actuators` を含まない — アクチュエータ変更の型検証は `npx tsc --noEmit` でなく **`pnpm run build:actuators`** で行う(ローカル全緑・CI 赤の原因)。

## リスクと注意

- **最大リスク: 意味論統一で既存テンプレの挙動が変わる**。golden(`check_golden_output`)を各段で回し、`while`/`foreach` の有無で壊れるテンプレを事前に洗う。段階移行(per-actuator → super-nerve の順)で影響を局所化。
- IP-05(CLI runner)と密接。**同時進行**でボイラープレート二重除去を避ける。
- 並列 op(`parallel_foreach`)の追加は HN-03 が所有。AR-01 は「1エンジンに集約」まで、並列拡張は HN-03 に委譲。
