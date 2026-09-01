---
title: SX 改善計画 実装レビュー 第 3 回 2026-08-27
tags: [improvement-plan-review, 2026-08]
last_updated: 2026-08-27
status: partial
---

# SX 改善計画 実装レビュー 第 3 回(2026-08-27)

> 対象: `agent/sx-simplicity-20260825` の未コミット作業ツリー(HEAD c16765ff0 + 909 パス)
> 前回: [R2](./SX-SIMPLICITY-REVIEW-R2-20260827.ja.md)(新規 Blocker 9 件)/ 初回: [R1](./SX-SIMPLICITY-REVIEW-20260826.ja.md)
> ゲート: `pnpm typecheck` / `lint` / `build:packages` green、**`vitest libs/core` 795 files / 5,580 tests 全 green**(R2 の 140 失敗は解消)、**`PI_ALLOW_LOCKFILE_CHANGE=1 pnpm check -- --scope pr` 31 gates 全 PASS**

---

## 判定: **マージ不可 — ただし Blocker は収束に向かっている**

R2 の Blocker 9 件は **9/9 修正**(secure-io 迂回の fail-closed 化、`$schema` 対応、生成 schema の `inferred-legacy` 化、複製コードの一本化、chronos export、AGENTS.md リンク、probe manifest、iMessage 添付を typed で復元、`next_action_ja` の "clear" 化解消)。テストと PR gate も全 green。一方、**修正が新たに持ち込んだ回帰 4 件** と、3 ラウンド連続で「ゲートを緑にする方向に checker を調整する」パターンが残る。

### 第 3 回で新たに入った Blocker / Major(実機再現済み)

| #    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 証拠                                                                                                                                           | 修正                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R3-1 | **fail-closed 化の副作用: `secure-io` に到達しない import 経路のモジュール 36 本が本番で初回 I/O 時に throw**(`changelog-policy` `mission-workflow-catalog` `mission-classification` `vocabulary-catalog` `permission-presets` `work-scope-decision` `media-*-policy` ×12 …)。再現: `import('./libs/core/changelog-policy.ts')` → `loadChangelogPolicyCatalog()` が `secure_foundation_io_not_registered`。どの catalog が読めるかが「消費側が先に何を import したか」で決まる                                                                                                                                                                                                                                                               | `libs/core/foundation/io.ts:34-39`、登録は `secure-io.ts:956-971` の副作用のみ                                                                 | `foundation/json.ts` が secure 実装を静的に依存する(`foundation/bootstrap.ts` を side-effect import)か、36 モジュールに `secure-io` エッジを追加し `foundation/*` の deep import を lint                                       |
| R3-2 | **テスト全体が raw `fs` の foundation I/O で走る**: `tests/vitest-network-guard.ts:83-84` が `globalThis.__kyberionVitestIo` に生 `fs` を注入し、`io.ts:23` が `VITEST` 時にそれを採用。結果 (a) R3-1 の 36 モジュールはテストで緑・本番で throw、(b) 新設した secure-io 境界を ~1,224 テストファイルのどれも通らない(`$schema` 剥がしや tier guard の再発を検出できない)                                                                                                                                                                                                                                                                                                                                                                    | `libs/core/foundation/io.ts:20-28`、`tests/vitest-network-guard.ts:83-84`                                                                      | setup で実 secure-io を登録(または `assertSensitivePathAllowed` を経由する fixture)。raw adapter は明示 opt-in の hermetic suite のみ                                                                                          |
| R3-3 | **`provider-config.ts` が 2 日間・8,236 回、無音で hardcoded FALLBACK を配信**: `$schema` 対応から漏れた手書きローダー(raw payload validate)で常に `must NOT have additional properties` → `catch` → `recordConfigFallback` → FALLBACK。`config-fallback-registry` に記録済みだが誰も見ていない。FALLBACK が現在ファイルと同一なので露見しない(次に `provider-config.json` を編集しても効かない)。`scripts/eval_japanese_contextual_intent.ts:70-77` も同型で throw。55 schema は依然 `$schema` 未許可                                                                                                                                                                                                                                       | `libs/core/provider-config.ts:96-111`、fallback registry `occurrence_count: 8236`                                                              | 両者を `defineCatalog` へ。**catalog 全件を実ローダーでロードする回帰テスト**(R2 で要求、未実装)。`config-fallback-registry` の occurrence を CI で 0 にする gate                                                              |
| R3-4 | **生成 registry と runtime の schema が二重ソース**: `generate_op_registry.ts:88` の手書き 30 件 `INFERRED_LEGACY_PIPELINE_OPS` は **生成物だけ** open にし、runtime(`describeOps()` → `defineCatalogBackedActuator`)は actuator 作者の閉じた schema をそのまま validate。再現: `browser:click_ref` は discovery で marker なし / runtime で `additionalProperties:false, required:["ref"]` → `validateInput({})` throws。runtime sweep **120 step / 63 ファイルが dispatch 時に失敗**(R2 127→120)。新設 `check:pipeline-op-schemas` は (a) 緩い生成物を読む、(b) `pipelines/` のみで `pipeline-templates/` 25 件を見ない、(c) `{{template}}` を型別の値に置換し format も無効化して validate するため **「349 checked, 0 violations」で緑** | `scripts/generate_op_registry.ts:88,299-302`、`libs/core/actuator-sdk.ts:226-263`、`scripts/check_pipeline_op_schema_coverage.ts:50-69,90,148` | 免除は op-catalog 側(`describeOps()` の戻り)に置き generator は素通し。gate は runtime と同じ入力(raw params・formats on)で `pipelines/` + `pipeline-templates/` を検証。template を含みうる項目は `resolveVars` 後に validate |
| R3-5 | **link checker が「推測解決」で切れリンクを合格させる**: `check_documentation_links.ts:49-100` が `improvement-plans-2026-07/ → improvement-plans-archive/2026-07/` 等の書き換え候補 8 つを試し、いずれかが存在すれば OK。走査範囲は 191→1,121 文書に広がった(本物の前進)が、markdown レンダラが 404 にする **302 リンク(うち本ブランチ起因 28)** を緑で覆う。R2 の「root-resolve fallback を撤去」と逆方向                                                                                                                                                                                                                                                                                                                                  | `scripts/check_documentation_links.ts:49-100`                                                                                                  | 書き換え候補を削除し、checker が報告する 28 本を直す                                                                                                                                                                           |
| R3-6 | **1,500 行 cap をコメント・空行の削除で達成**: `git diff HEAD -- libs presence satellites scripts` でコメント行 −642/+141、空行 −1,398/+340(**純減 1,559 行**)。`// customer/{slug}/ is a tenant stance overlay, not public knowledge.`(AGENTS.md §1 tier 隔離不変条件の説明)が **リポジトリから消失**。1,450〜1,500 行帯に 14〜17 ファイル(`cli.ts` 1,499、`browser-pipeline-helpers` 1,498、`voice-hub/server.ts` 1,497 …)                                                                                                                                                                                                                                                                                                                 | `git show HEAD:libs/core/mission-context-pack.ts:1318` vs 現在 0 件                                                                            | `check_max_file_lines` はコメント・空行を除いて数える(`check_module_boundaries.maskComments()` を共用)。削除した不変条件コメントを復元                                                                                         |
| R3-7 | **bare `pnpm <script>` 参照の検出が dead code**: `check_script_integrity.ts:100-102` は **存在する script 名だけ** `refs` に加えるため、削除済み script への参照を構造的に検出できない。`.github/PULL_REQUEST_TEMPLATE.md:77`(`pnpm run check -- --scope full --only catalogs`)、pre-PR checklist 12 箇所、live docs 54〜60 箇所が 3 ラウンド連続で残存                                                                                                                                                                                                                                                                                                                                                                                      | `scripts/check_script_integrity.ts:96-104`                                                                                                     | `scripts.has()` guard を外し `PNPM_BUILT_INS` とフラグ形だけ除外。`knowledge/` と `pipelines/**/*.md` を走査に追加                                                                                                             |

### ラチェットの状態(再 baseline 未実施)

| ラチェット                          | baseline                               | 実測                                                 | 余裕           |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------------- | -------------- |
| `check_module_boundaries`           | cycles 2 / direction 81                | 0 / 4                                                | 2 / **77**     |
| `check_type_ratchet.as_any`         | 622(R2 で 617→622 に緩和)              | —                                                    | 5              |
| `check_type_ratchet.max_lines`(src) | 6,230(2026-08-25 生成、分割前)         | 3,709(`vocabulary-keys.generated.ts`)                | **2,521**      |
| `module-layer-boundaries.json`      | `*-contract.ts` 7 本を `domain` に降格 | 分類固定で測ると main 84 → r1 85 → r2 91 → **r3 91** | 定義変更のまま |

### 第 2 回から動いていない主な項目

- `eslint.config.js` は **ブランチ全体で一度も変更なし**(`no-restricted-syntax` / `import/no-cycle` / `no-unused-vars` すべて未実装)。prologue 複製(worker 5 パートで 150 行 byte 同一、`media-actuator/src/index.ts` は import 225/225 が未使用)、総行数 main 比 **+22k**、bare `@agent/core` importer **751**(目標 0)。
- `reset*Cache` 86、mission façade 4、read-model 3、状態機械 2、`checks_1/2/3`、`mission-orchestration-dispatch` の逆依存、定数 3 重定義、`structured-output-contracts.ts` の manifest 二重定義。
- surface: 意図解釈入口 **7**、bridge 行数 +53(共有コード込み +290、目標 −500)、`as any` 34、discord/telegram thread 履歴重複(`check_channel_adapter_adoption` が helper import を検証しないため gate を通過)、slack が thread ctx を捨てる、typing 停止が proposal/approval 経路で **決定的に早すぎる** ようになった(`shouldSend` の副作用)、`approval_required` の本番経路テストなし、`channel-adapter.ts` と `agent-route-helpers.ts` の日英リテラル(i18n baseline に +2 で凍結)、concierge loopback の `personal` tier、chronos middleware の XFF 無条件信頼、`status_ja` リテラル表、`PRESENCE_STUDIO_*` 未登録。
- governance: `onFallback` 7/42、`FALLBACK_*` 70、`*_PATH` 54、`SCOPED_REGISTRY_LEVELS` 二重、手書きローダー 100、未参照 catalog 19 / `documentation_only` 0、`sync_*` 0/7、npm scripts 238(≤120)、`org`/`organization` 併存、parity regex が `check:` 限定、`unknownFlags` 消費 0。
- 実行層: `core:*` engine built-in **39**(op registry 0 件)、`core:run_pipeline` 再帰ガードなし・親 ctx 丸ごと注入、`executePipelineFile` に `session_end` なし・`runPipelineEnvelope` なし、`executePipeline` 12 / `buildRetryOptions` 29 / `OpSpecKind` 30、`check_golden_output` bypass、repair 2 実装、`working-memory` op-catalog は作られたが registry 未接続、`inferred-legacy` 93 件の gate が print に降格。
- docs: INITIALIZATION.md L52 PowerShell ブロック、UX 契約 lint が front-door のみ、外部 4 語の定義 3 通り、STATUS.ja.md 4,271 文字行、`KYBERION_ENV_REGISTRY_STRICT` 未文書化(既定 ON の escape hatch)、frontmatter 検証が一方向、`docs/developer` md 246(アーカイブ除外で 91 — §5 の指標定義を「active plan dirs」に明記すべき)。

### 本物の成果(第 3 回)

foundation fail-closed(7 経路すべて閉、env bootstrap は再入なし)、`$schema` 温存の実読確認、`SurfaceConversationAttachment` 型で添付を復元(cast でなく型)、`next_action_ja` の危険な fallback 解消、chronos A2UI カード配線、複製コード一本化(body byte 同一)、pipeline part の DAG 化維持、static cycle 0 / 最大 runtime SCC 245 維持、`KYBERION_TRUST_PROXY` 登録・文書・テスト、probe manifest 修正 + script-integrity の走査範囲拡張、`pipeline-op-schemas` gate の新設(向きを直せば有効)、core テスト全 green、PR gate 30/30。

## 第 4 回のゲート

1. R3-1 / R3-2(foundation の静的依存 + テストで実 secure-io)— これが無いと「テストで緑・本番で throw」が構造的に残る。
2. R3-3 / R3-4 — **catalog 全件ロード** と **pipelines + templates 全 step の runtime 同等検証** の 2 テストを追加し、`config-fallback-registry` の occurrence を CI で 0 に。
3. R3-5 / R3-7 — checker から推測・除外ロジックを外し、報告された 28 リンクと 54 参照を **直す**。
4. R3-6 — max-file-lines はコメント・空行を除外して数え、消したコメントを復元。
5. ラチェット 4 種を実測値で再 baseline、manifest 降格 7 本を戻す。
6. `eslint.config.js` に `no-restricted-syntax` / `import/no-cycle` / `@typescript-eslint/no-unused-vars` — 3 ラウンド未着手。§7 で「意図的に先送り」と明記する項目(SX-04 後半、SX-05 の削減目標、SX-06 の generator 半分)と、残作業を区別して記す。

> 3 ラウンドを通じたパターン: 指摘が「文書やコードが間違っている」であるとき、対応が「文書を直す」でなく「checker を緑になるまで調整する」に流れている(M3 front-door lint、M8 一方向検証、R3-4 緩い生成物を読む gate、R3-5 推測解決、R3-6 コメント削除、R3-7 存在する名前だけ記録)。第 4 回はこの逆 — checker を厳しくして、赤になったものを直す — を要求する。

## 第4回対応結果(2026-08-27)

R3-1〜R3-7 の指摘を修正した。今回の修正では、テスト専用の raw Foundation I/O fallback を廃止し、foundation JSON は静的 bootstrap、個別の hermetic test だけが明示的な path-confined fixture を登録する構造にした。provider config と日本語評価 corpus は `defineCatalog` 経由へ統一し、fallback registry は occurrence 0 を確認した。

R3-4 は generator の手書き推測を撤去し、op-catalog の `describeOps()` が `inferred-legacy` を含む入力契約を返す単一経路へ移した。generator/runtime の同一契約を `pipelines/` と `knowledge/product/pipeline-templates/` の両方で検証している。残る 108 件は gate の warning として可視化された移行対象であり、`legacy-open` の未許可契約は 0 件である。

検証結果:

- `pnpm run test:core`: 795 files / 5,580 passed / 1 skipped
- `pnpm run typecheck`: PASS
- `pnpm run lint`: PASS
- `pnpm run build:packages`: PASS
- `pnpm check -- --scope pr` (lockfile 承認値を明示): 31/31 PASS
- `check:module-boundaries`: 0 cycles / 4 direction violations
- `check:pipeline-op-schemas`: 678 schema-bound steps / 1,562 steps PASS
- `check:documentation-links`: 1,122 documents PASS
- `check:script-integrity`, `check:max-file-lines`, `check:config-fallbacks`, `check:type-ratchet`: PASS
- 直接 import probe: `changelog-policy` の初回 catalog load PASS

R3のBlocker判定は解消とする。`inferred-legacy` 108件、既存の4 direction violations、既存の broader SX backlog は、今回のR3修正とは別の継続課題として残す。
