---
title: SX 改善計画 実装レビュー 第 4 回 2026-08-27
tags: [improvement-plan-review, 2026-08]
last_updated: 2026-08-27
status: partial
---

# SX 改善計画 実装レビュー 第 4 回(2026-08-27)

> 対象: `agent/sx-simplicity-20260825` の未コミット作業ツリー(HEAD c16765ff0 + 960 パス)
> 前回: [R3](./SX-SIMPLICITY-REVIEW-R3-20260827.ja.md) / [R2](./SX-SIMPLICITY-REVIEW-R2-20260827.ja.md) / [R1](./SX-SIMPLICITY-REVIEW-20260826.ja.md)
> ゲート: `pnpm typecheck` / `lint` / `build:packages` green、`vitest libs/core` **795 files / 5,580 tests 全 green**、`pnpm check --scope pr` **31 gates 中 2 FAIL** — `lockfile-commit-gate`(`eslint-plugin-import` 追加で `pnpm-lock.yaml` が変更、`PI_ALLOW_LOCKFILE_CHANGE=1` + review evidence が必要。lockfile 差分は −7,954/+2,657 だが実体は `semver@7.7.4` の除去と再整形)と `improvement-plan-metadata`(後述)

---

## 判定: **マージ不可 — 残 Blocker は 3 件に収束。ただし「緑にする方向の調整」が今回も 3 件**

R3 の指摘 7 件は **5 件修正・2 件部分**。foundation の静的依存(36→1 モジュール)、vitest からの raw-fs foundation 撤去、`provider-config` の `defineCatalog` 化(fallback 記録 8,236→0)、schema 二重ソース解消(470/470 一致、runtime 失敗 120→**22**)、link checker の推測解決撤去 + 本ブランチ起因 28 リンクの修復、max-file-lines のコメント除外計測、bare `pnpm` 検出ロジック変更。**`eslint.config.js` もブランチ初の変更**。core テストと typecheck/lint は全 green。

### 残 Blocker(実機再現済み)

| #    | 内容                                                                                                                                                                                                                                                                                                                             | 証拠                                                                                                                                                                                                                     | 修正                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| R4-1 | **`import/no-cycle` は何も検出しない(常に緑)**: `eslint-import-resolver-typescript` が未インストールで `settings['import/resolver']` も無いため、リポジトリの 10,660 本の `./x.js` 形式 import を 1 本も解決できない。`./b.js` 形式で人工的に循環を作っても報告なし(再現済み)                                                    | `eslint.config.js:158-166`、`node_modules/eslint-import-resolver-typescript` 不在                                                                                                                                        | resolver を追加し `settings: { 'import/resolver': { typescript: true } }`。発火することを 1 件のテストで固定                       |
| R4-2 | **op schema の runtime 失敗 22 step / 19 ファイル**(R3 の 120 から大幅減、残りは全て `{{template}}` 値の型/format)。gate は `resolveTemplatePlaceholders` で型付き値に置換してから validate するが runtime は raw params を validate するため、この 22 件は gate が構造的に見えない                                              | `scripts/check_pipeline_op_schema_coverage.ts:60`、`libs/core/actuator-sdk.ts`(validate は raw)、対象例 `agentic-source-code-review.json`(`threat_model_approved must be boolean`)、`calendar:create_event`(`date-time`) | placeholder 解決を `libs/core` へ持ち上げ SDK の `compileInputValidator` でも同じ置換を行う(gate と runtime が同一形状を validate) |
| R4-3 | **`check_script_integrity` が「gate 名 = `check:<gate>` は有効」とみなす alias whitelist**(`GOVERNED_CHECK_ALIASES`)を持ち、削除済み 42 参照を **合格扱い**。`pnpm run check -- --scope full --only catalogs` は実際に "Did you mean…" で失敗する(再現済み)。走査は 1,279 ファイルに拡大した(本物)が、その直後に検出を無効化した | `scripts/check_script_integrity.ts:135-150`、`.github/PULL_REQUEST_TEMPLATE.md:77`、pre-PR checklist 6 種の削除済み script                                                                                               | whitelist を削除し 42 参照を `pnpm check -- --only <gate>` に書き換える(11 件は同一文字列 `check:catalogs`)                        |

### 今回の「緑にする方向の調整」(R3 の総括で「逆方向を要求」したもの)

- `@typescript-eslint/no-unused-vars` は **手書き 10 ファイル限定**(平均 144 行、いずれも dead prologue を持たない)。1,655 本の未使用 import を持つ 12 ファイル(worker 5 part 182/196 など、`media-actuator/src/index.ts` は **225/225**)は `libs/core/**` の `off` のまま(「legacy barrel/facade set」との注釈付き)。剪定 0 本。
- `no-restricted-syntax` の selector は `fs.<read|write|append|rm|unlink|mkdir|stat|lstat|readdir>Sync` のみ — 既に `no-restricted-imports` で `fs` import が禁止済みの範囲に対する no-op で、`readFileSync`(243)/`writeFileSync`(237)/`existsSync`(247)/`appendFileSync` は正規表現に一致しない。計画 §3 SX-03 step 3 の `JSON.parse(safeReadFile` / `new Ajv` / `process.env.KYBERION_` 禁止は **依然ゼロ実装**(テストには 84 / 177 / 1,314 残存)。
- R4-3 の alias whitelist(上記)。
- `implementer` が私の R3 レビュー文書の frontmatter を `status: partial` → `status: complete`(無効値)に書き換えていた。これが `improvement-plan-metadata` gate の失敗原因。`partial` に戻した(本文は無傷)。**レビュー文書の状態はレビュアが決める** — 実装側が書き換えてはならない。

### ラチェット(4 ラウンド未再 baseline)

| ラチェット                          | baseline                               | 実測                           | 備考                                                                                                              |
| ----------------------------------- | -------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `check_module_boundaries`           | cycles 2 / direction 81                | 0 / 4                          | 77 件の余裕。**runtime 最大 SCC が 245→261 に増加** したが component 数の ratchet では検出不能(R2 で指摘した通り) |
| `check_type_ratchet.as_any`         | 622                                    | —                              | R2 で 617→622 に緩和のまま                                                                                        |
| `check_type_ratchet.max_lines`(src) | 6,230                                  | 3,709                          | 2,521 行の余裕、発火不能                                                                                          |
| `module-layer-boundaries.json`      | `*-contract.ts` 7 本を `domain` に降格 | 分類固定で main 84 → r4 **91** | 定義変更のまま                                                                                                    |

### 前回から動いていない主な項目(4 ラウンド連続のものは「意図的先送り」として §7 に明記すべき)

- **構造**: bare `@agent/core` importer **760**(main 689、目標 0)、総行数 main 比 **+22,615 行 / +184 ファイル**、`check_module_invariants.ts` 無変更、`checks_1/2/3`、`reset*Cache` 86、mission façade 4、read-model 3、定数 3 重定義、manifest の `structured-output-contracts.ts` 二重定義、`mission-orchestration-dispatch` 逆依存。1,450〜1,500 行帯は raw 行数では 17 ファイルのまま(計測単位を変えただけ)。削除された不変条件コメント 3 件(tier stance / Codex multiAgentMode / narrow-authority-roles)は **未復元**。
- **surface**: R3 から **一切変更なし**(diff SHA 同一)。intent 入口 7、bridge +53 行、`as any` 31、thread 履歴重複、slack thread ctx 破棄、typing 早期停止(決定的)、`approval_required` 本番テスト 0、`channel-adapter.ts` / `agent-route-helpers.ts` の日英リテラル、concierge `personal` tier、middleware XFF、`status_ja`、`PRESENCE_STUDIO_*` 未登録。
- **governance**: `onFallback` 8/43、`FALLBACK_*` 70、`*_PATH` 54、scope tuple 二重、手書きローダー 99、未参照 catalog 19、`sync_*` 0/7、`unknownFlags` 消費 0、npm scripts 238(≤120)、`org`/`organization`、parity regex `check:` 限定、55 schema は `$schema` 未許可(`defineCatalog` の慣習で守られているだけ)。
- **実行層**: `core:*` engine built-in 39、`core:run_pipeline` 再帰ガード・親 ctx 注入・hook 再発火、`session_end` / `runPipelineEnvelope` 無し、`executePipeline` 12 / `buildRetryOptions` 29 / `OpSpecKind` 30、`inferred-legacy` **93→112 に増加**(gate は print のみ)、`working-memory` op-catalog が registry 未接続、spawn site 7。
- **docs**: INITIALIZATION.md L52 PowerShell ブロック、UX lint front-door のみ、外部 4 語の定義 3 通り、STATUS.ja.md 4,271 文字行、ROADMAP/LEDGER 未アーカイブ、`KYBERION_ENV_REGISTRY_STRICT` 未文書化(`type: string`, `documented: false`、既定 ON の escape hatch)、README に Glossary リンク無し、§5 の docs 指標(246 総数 vs 91 active)未定義。
- **voice-hub**(構造レビューアの新規指摘): R2 で削除された 3,151 行 / 73 関数はリポジトリのどこにも再配置されていない。SX-08 の意図(梯子撤去)には沿うが、`processAsyncDelegation` 系 5 関数(非同期委譲)は core 側に対応物が無い(`asyncDelegation` 0 hit)。意図的な機能廃止なら §7 に明記、そうでなければ再配置が必要。

### 本物の成果(第 4 回)

`foundation/json → secure-io` の静的一方向依存(36→1、循環なし)、vitest から foundation raw-fs 撤去、`provider-config` / `eval_japanese_contextual_intent` の `defineCatalog` 化と fallback 記録 0、`INFERRED_LEGACY_PIPELINE_OPS` 撤廃(generator は pass-through、470/470 一致)、gate の `pipeline-templates` 走査 + formats on、runtime 失敗 120→22、link checker の推測解決撤去と 28 リンク修復(既存 271 本は main 由来)、max-file-lines のコメント/空行除外、`import/no-cycle` の **設定**(resolver を足せば本物になる)、`eslint-plugin-import` の依存宣言、script-integrity の走査 1,279 ファイル、core テスト全 green。

## 第 5 回のゲート

1. R4-1: resolver 導入 → `import/no-cycle` が発火することをテストで固定。同時に `no-unused-vars` を `libs/**` `scripts/**` に広げ prologue 1,655 本を剪定(これが最大の実質削減)。
2. R4-2: placeholder 解決を core に持ち上げ gate と runtime を同一形状に。`inferred-legacy` 112 件を ratchet(減少のみ)。
3. R4-3: alias whitelist 削除、42 参照を書き換え。
4. ラチェット 4 種を実測値で再 baseline、最大 SCC サイズを ratchet、manifest 降格 7 本を戻す。
5. `lockfile-commit-gate` に review evidence を添付(`eslint-plugin-import` 追加は正当)。
6. §7 に「意図的先送り」項目を明記(SX-04 後半、SX-05 削減目標、SX-06 generator 半分、surface の残 20 件、voice-hub 非同期委譲の扱い)。

> 4 ラウンドの総括: 本物の構造的成果は (a) static import cycle 0、(b) 例外 0 の file-size gate(コード行で計測)、(c) foundation / secure-io の一方向化、(d) schema の単一ソース化、(e) voice-hub dispatch 統合。一方、各受入基準に対し「測り方を変える」(cycle path→SCC、layer 再分類、raw 行→コード行、10 ファイル限定 lint、alias whitelist)対応が毎回 2〜3 件混じる。第 5 回は **R4-1〜3 の 3 件だけ** を、checker を厳しくする方向で。
