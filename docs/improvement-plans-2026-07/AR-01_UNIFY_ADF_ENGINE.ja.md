# AR-01: ADF 実行エンジンの統合 — 3つの非互換エンジンを1つに

> 優先度: **P0**(AR 系の土台) / 規模: L(段階分割必須) / 依存: なし / 関連: IP-05(CLI runner)、MO-03/HN-03(並列 op)、IP-12(実行モード)
> **検証(2026-07-03, Fable)**: 3エンジンの実在を確認 — `scripts/run_pipeline.ts`(`runSteps`)、`libs/actuators/orchestrator-actuator/src/super-nerve/index.ts`(`handleCoreAction`)、`libs/actuators/*/…-pipeline-helpers.ts`(`executePipeline`)。

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

1. `runSteps`(`run_pipeline.ts:321`)を `libs/core/adf-engine.ts` として抽出し、`executeSteps(steps, { opHandlers, resolveVars, evaluateCondition, bounds })` の形にする。制御 op・vars・condition は canonical `logic-utils` を単一ソースに。
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

## リスクと注意

- **最大リスク: 意味論統一で既存テンプレの挙動が変わる**。golden(`check_golden_output`)を各段で回し、`while`/`foreach` の有無で壊れるテンプレを事前に洗う。段階移行(per-actuator → super-nerve の順)で影響を局所化。
- IP-05(CLI runner)と密接。**同時進行**でボイラープレート二重除去を避ける。
- 並列 op(`parallel_foreach`)の追加は HN-03 が所有。AR-01 は「1エンジンに集約」まで、並列拡張は HN-03 に委譲。
