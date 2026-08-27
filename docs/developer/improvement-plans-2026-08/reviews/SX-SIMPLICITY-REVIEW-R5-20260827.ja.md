---
title: SX 改善計画 実装レビュー 第 5 回 2026-08-27
tags: [improvement-plan-review, 2026-08]
last_updated: 2026-08-27
status: partial
---

# SX 改善計画 実装レビュー 第 5 回(2026-08-27)

> 対象: `agent/sx-simplicity-20260825` の未コミット作業ツリー(HEAD c16765ff0 + 977 パス)
> 前回: [R4](./SX-SIMPLICITY-REVIEW-R4-20260827.ja.md) / [R3](./SX-SIMPLICITY-REVIEW-R3-20260827.ja.md) / [R2](./SX-SIMPLICITY-REVIEW-R2-20260827.ja.md) / [R1](./SX-SIMPLICITY-REVIEW-20260826.ja.md)
> ゲート: `pnpm typecheck` / `lint` / `build:packages` green、`vitest libs/core` **795 files / 5,581 tests 全 green**、`pnpm check --scope pr` **31 gates 中 1 FAIL**(`lockfile-commit-gate` のみ — 差分は `eslint-plugin-import@2.32.0` / `eslint-import-resolver-typescript@3.10.1` の exact-pin 追加と `semver` 5 消費者の 7.8.5 統合、`patchedDependencies` 無変更で **安全と判定**。残りは prettier 再整形ノイズ)

---

## 判定: **マージ不可 — Blocker 2 件。docs 領域は承認水準に到達**

R4 の残 Blocker 3 件のうち **R4-3(alias whitelist)は完全解決**(live corpus の削除 script 参照 57→**0**、PR テンプレート・checklist 6 コマンドを `pnpm check -- --only <gate>` に書き換え)。**docs 領域はレビュアが承認**(link checker の推測解決撤去 + 28 リンク修復でリポジトリの切れリンクは main 以下。残る必須修正は INITIALIZATION.md L52 の 2 行のみ)。一方、R4-1 と R4-2 の対応は **どちらも「症状を消して別の問題を作った」**。

### Blocker(実機再現済み)

| #    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 証拠                                                                                                          | 修正                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5-1 | **placeholder 解決済みの入力が handler に渡る**: R4-2 の対応で `resolvePipelineInputPlaceholders` を `libs/core/pipeline-input-contract.ts` に共通化(gate と runtime が同一形状を validate — これ自体は正しい)したが、SDK の validator が **置換後のオブジェクトを返し**、それが handler に渡る。再現: `media:visual_review` に `{tenant_slug:'{{tenant_slug}}', tier:'{{tier}}', mission_id:'{{mission_id}}'}` → validator 出力 `{tenant_slug:'', tier:'', mission_id:''}`。実カタログで **108/191 step(57%)、229 フィールド、56 ファイル** が `''` / `0` / `false` / `[]` / `{}` に化ける(`code:semgrep_scan` の `target_dir`、`media:apply_theme` の `{{… \| default: 'auto'}}` も破壊)。R4 の「22 件が大声で失敗」が「108 件が無音で誤動作」に変わった。**tenant/tier scope が空文字で actuator に届く**のは tier 隔離不変条件に触れる | `libs/core/actuator-sdk.ts:198-201,319-320`                                                                   | `validateInput` は probe(置換コピー)を validate し **元の input を返す**(`if (validate(probe)) return input`)。validator の戻り値が identity であることをテストで固定                                                   |
| R5-2 | **`import/no-cycle` は「解決できない」から「対象ゼロ」へ**: resolver は導入され `import/no-unresolved` は 0 件で解決するが、rule の `files` が **`libs/core/pipeline-input-contract.ts`(59 行・import 0 本)+ fixture** に絞られ、その fixture は **global `ignores` に登録**されている(コメントに "repository-wide false-positive flood を避けるため" と明記)。`libs/core` に人工循環を置いても 0 件、`--no-ignore` で fixture を lint すると 2 件 — rule は動くが 1 ファイルしか見ていない。さらに fixture `scripts/eslint-import-cycle-fixture/{first,second}.ts` は gitignore されず tsconfig `include` 内にあり、`check_module_boundaries` の走査対象なので **static cycle が 0→1 に回帰**(baseline 2 の余裕で緑)。3 ラウンド守った「static cycle 0」を、動かない rule の実演のために手放した                                          | `eslint.config.js:27,167-168`、`scripts/eslint-import-cycle-fixture/`、`check_module_boundaries` 実測 1 cycle | rule を `libs/**` `scripts/**` に広げ、出た件数を **baseline として凍結**(scope で避けない)。fixture は `tests/fixtures/` 等の両ツール除外パスへ移し global ignore から外す(rule が実際に fixture で発火する状態にする) |

### 却下した指摘

- 構造レビューアの「`loadJson` が `$schema` を剥がさなくなった(N11)」は **第 1 回で本レビューが要求した修正(B2)そのもの**であり回帰ではない。残リスク(55 schema が `$schema` を許可せず、`defineCatalog` の慣習で守られているだけ)は N2 として継続追跡。

### 今回の「緑にする方向の調整」

- R5-2 の scope 縮小(rule 対象 1 ファイル + ignore 済み fixture)。
- `no-unused-vars` は **10 ファイル限定のまま**(1,655 本の未使用 import、`media-actuator/src/index.ts` 225/225 は据え置き、剪定 0 本 — 3 ラウンド連続)。
- `no-restricted-syntax` は `fs.*Sync` 単一 selector のまま(計画の 3 禁止パターンはテスト側に 84 / 177 / 1,314 残存)。
- 計画 §3 の **症状記述が実装に合わせて書き換えられている**(SX-11「`orchestrator.ts` は削除済み」、SX-12「`adapters/` shim は削除済み」)。監査時点の記録が消え、受入基準の before/after が失われる。実装状況は §7 に書く。
- foundation レビューアの実測: R4 の `foundation/json.ts → import '../secure-io.js'` が `secure-io → audit-chain → (dynamic) audit-forwarder → network → egress-policy → foundation/governed-catalog` の **runtime 循環を再生成**(baseline `runtime_cycles: 2` に吸収されて緑)。方向違反 4 件のうち 2 件は `secure-io [foundation] → audit-chain / tier-guard [domain]` で、SX-02/03 の受入基準に反する。

### ラチェット(5 ラウンド未再 baseline — 今回それが実害を出した)

| ラチェット                          | baseline                            | 実測                           | 備考                                                |
| ----------------------------------- | ----------------------------------- | ------------------------------ | --------------------------------------------------- |
| `check_module_boundaries`           | cycles 2 / runtime 2 / direction 81 | **1** / 2 / 4                  | static 0→1 の回帰を余裕で吸収。最大 runtime SCC 261 |
| `check_type_ratchet.as_any`         | 622                                 | —                              | R2 で緩和のまま                                     |
| `check_type_ratchet.max_lines`(src) | 6,230                               | 3,709                          | 発火不能                                            |
| `module-layer-boundaries.json`      | `*-contract.ts` 7 本降格            | 分類固定で main 84 → r5 **91** | 定義変更のまま                                      |
| `inferred-legacy` op                | なし                                | **112**(93→112 増加)           | gate は print のみ、`baseline` field 未使用         |

### 前回から動いていない主な項目

- **surface**: R3 から 3 ラウンド連続で **変更なし**(scoped diff SHA 同一)。最低限: thread 履歴重複 2 bridge、slack thread ctx 破棄、typing 早期停止、`approval_required` 本番テスト。release 前: concierge `personal` tier、`ALLOW_UNAUTH_REMOTE` の移行注記、middleware XFF。
- **構造**: bare `@agent/core` importer **761**、総行数 main 比 **+22,698 行 / +190 ファイル**、`check_module_invariants.ts` 無変更、削除された不変条件コメント 3 件未復元、`reset*Cache` 86、façade 4、`checks_1/2/3`、manifest 二重定義。
- **governance**: `onFallback` 8/43、`FALLBACK_*` 70、`*_PATH` 54、scope tuple 二重、手書きローダー 99、未参照 catalog 19、`sync_*` 0/7、`unknownFlags` 消費 0、npm scripts 238、checklist 187 行。§7 の先送り明記は SX-05 のみ完了、SX-04 / SX-06 は未記載。
- **実行層**: `core:*` built-in 39、`core:run_pipeline` 再帰ガード無し・親 ctx 注入、`session_end` 無し、dedup 0、`working-memory` registry 未接続。
- **docs**: INITIALIZATION.md L52、`KYBERION_ENV_REGISTRY_STRICT` 未文書化(既定 ON の escape hatch)、UX lint front-door のみ + 外部 4 語の定義 3 通り、STATUS.ja.md 4,271 文字行、README に Glossary リンク無し、§5 docs 指標の定義(248 総数 / 93 active)、§7 の「191 文書」は 1,123 に更新要。
- **新規(minor)**: `.prettierignore` に `pnpm-lock.yaml` が無く `pnpm format` ↔ `pnpm install` で 1 万行の往復ノイズが出る(lockfile gate を実質読めなくしている。1 行で解決)。`lockfile-commit-gate` の "review evidence" は文言だけで検証されない env-var bypass。`check:catalogs` が要求する `pnpm generate:knowledge-index` は 3 ラウンド未実行(私の実行では通ったが、実装側の手順に組み込むこと)。

### 本物の成果(第 5 回)

削除 script 参照の live corpus 0 化(checker を緩めず文書を直した — 第 3 回で要求した「逆方向」の初の実例)、gate と runtime の placeholder 解決共通化(戻り値の問題を除けば正しい設計)、`eslint-import-resolver-typescript` の導入(rule 自体は動く)、lockfile 変更の安全性、docs 領域の承認、SX-05 の §7 先送り明記、テスト 5,581 全 green。

## 第 6 回のゲート(この 2 件 + 3 件)

1. **R5-1**: `validateInput` を identity 保存に(1 行)+ 回帰テスト。
2. **R5-2**: fixture を両ツール除外パスへ移動し global ignore から外す。`import/no-cycle` を `libs/**` `scripts/**` に広げ、出た件数を baseline 凍結。static cycle を 0 に戻す。
3. ラチェット再 baseline(boundaries 1/2/4 → 実測、`as_any` ≤617、`max_lines` 実測、`inferred-legacy` 112 を減少のみ)。最大 SCC サイズを ratchet に。
4. `.prettierignore` に `pnpm-lock.yaml`、lockfile gate に evidence を添付、INITIALIZATION.md L52。
5. §3 の症状書き換えを §7 に戻し、SX-04 / SX-06 の先送りを明記。

> 5 ラウンドの総括: 本物の構造的成果は変わらず 5 つ(static cycle 0 — 今回 fixture で崩れた、file-size gate、foundation/secure-io の一方向化 — 今回 runtime 循環が再発、schema 単一ソース、voice-hub dispatch 統合)に、第 5 回で「文書を直す」型の修正が 1 件加わった。残 Blocker は 2 件でどちらも小さい。ただし **surface 領域は 3 ラウンド放置**、ラチェットは 5 ラウンド未更新で今回初めて実害(cycle 回帰の吸収)が出た。第 6 回は R5-1 / R5-2 とラチェット再 baseline のみで可。
