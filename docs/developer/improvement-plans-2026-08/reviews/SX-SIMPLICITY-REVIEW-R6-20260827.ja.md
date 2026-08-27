---
title: SX 改善計画 実装レビュー 第 6 回 2026-08-27
tags: [improvement-plan-review, 2026-08]
last_updated: 2026-08-27
status: partial
---

# SX 改善計画 実装レビュー 第 6 回(2026-08-27)

> 対象: `agent/sx-simplicity-20260825` の未コミット作業ツリー(HEAD c16765ff0 + 986 パス)
> 前回: [R5](./SX-SIMPLICITY-REVIEW-R5-20260827.ja.md) / [R4](./SX-SIMPLICITY-REVIEW-R4-20260827.ja.md) / [R3](./SX-SIMPLICITY-REVIEW-R3-20260827.ja.md) / [R2](./SX-SIMPLICITY-REVIEW-R2-20260827.ja.md) / [R1](./SX-SIMPLICITY-REVIEW-20260826.ja.md)
> ゲート: `pnpm typecheck` / `lint` / `build:packages` green、`vitest libs/core` **795 files / 5,581 tests 全 green**、`pnpm check --scope pr` **31 gates 中 30 PASS**(残り `lockfile-commit-gate` は evidence ファイル添付で通る。差分自体は安全と判定済み)

---

## 判定: **条件付き承認(approve with conditions)— Blocker 0、マージ前条件 3 件**

6 ラウンドで **初めて、指摘を「測り方を変える」でなく「コードとラチェットを変える」ことで閉じた回**。R5 の Blocker 2 件は解消:

- **R5-1** validator は元の入力を返す(`if (validate(probe)) return input`)。実カタログ 191 step で **参照同一性を確認、変異 0**。参照同一性を assert する回帰テスト追加(`actuator-sdk.test.ts:179-193`)。
- **R5-2** fixture を `tests/fixtures/eslint-import-cycle/` へ移動(tsconfig / boundary checker の外)、`import/no-cycle` を `libs/**` `scripts/**` に拡張、**static cycle 0 に復帰**。

さらに: boundaries baseline を **余裕ゼロの実測値**に再設定(`cycles:0, direction_violations:4`)し **`max_runtime_scc_size: 261` を増加禁止 ratchet に**(R4 の 245→261、R5 の 0→1 を検出できた指標)。type ratchet は `as_any` 622→**610**(R1 の 617 を下回る — R2 の緩和を取り消し)、`max_lines` 6,230→3,709(実測ぴったり)。`inferred-legacy` 112 件に減少のみ ratchet。lockfile gate は `PI_LOCKFILE_REVIEW_EVIDENCE` ファイル必須の 2 要素に。`.prettierignore` に `pnpm-lock.yaml`。INITIALIZATION.md の最後の順序不備解消(**docs 領域: approve-with-nits**)。計画 §3 の症状書き換えを §7 へ戻し、SX-04/06 の先送りを明記、§7 SX-10 の「inferred-legacy 0」を実態の 112 に訂正。**実行層: approve**。

### マージ前条件(小さい・機械的)

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 証拠                                                                                   | 修正                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `scripts/check_op_input_contract_coverage.baseline.json` が **untracked**。コミットしないと CI で ratchet が `safeExistsSync` guard により無音 no-op                                                                                                                                                                                                                                                                                                                                                             | `git status` `??`、`check_op_input_contract_coverage.ts:63`                            | `git add`。ついでに `ci-gates.json` の `baseline` field から参照                                                                        |
| C2  | `lockfile-commit-gate` の evidence ファイルを作成し `PI_LOCKFILE_REVIEW_EVIDENCE` で指す(内容: `eslint-plugin-import@2.32.0` / `eslint-import-resolver-typescript@3.10.1` exact-pin 追加、`semver` 5 消費者の 7.8.5 統合、`patchedDependencies` 無変更 — 本レビューで確認済み)                                                                                                                                                                                                                                   | `check_lockfile_commit_gate.ts:25-39`                                                  | evidence に `pnpm-lock.yaml` の content hash を含めると改竄検知になる(minor)                                                            |
| C3  | **`governance-action-recorder` の buffer 化**(N14): `recordGovernanceAction` が `kill-switch.ts` から foundation 層の新モジュールへ移り、sink 未登録時は in-memory queue(上限 256、超過で最古を **無音破棄**)。再現: `secure-io` だけ読み込んだプロセスで 300 件記録 → 後から sink 登録で **256 件しか届かない**。旧実装も in-memory(agent ごと 200 件)で永続化はしていなかったため監査台帳の欠落ではないが、`kill-switch` を読み込まないプロセスでは異常検知(`detectAnomalies`)が黙って無効化される。テスト無し | `libs/core/governance-action-recorder.ts:10,35`、sink 登録は `kill-switch.ts:303` のみ | sink 未登録で上限到達時に warn、`kill-switch` を読み込まない経路の明示(または recorder が遅延 import で kill-switch を確保)、テスト追加 |

### 却下 / 格下げした指摘

- 構造レビューアの N11(`loadJson` の `$schema` 剥がし撤去)は R1-B2 で本レビューが要求した修正。却下(継続リスクは N2「55 schema」として追跡)。
- governance レビューアの N5(knowledge index 陳腐化)は私のレビュー文書追加による一時的なもの。本 `pnpm check --scope pr` では `catalogs` は PASS。実装側の手順に `pnpm generate:knowledge-index` を組み込むこと。

### 継続する「緑の理由」の注記(Blocker ではないが §7 に明記すべき)

- `import/no-cycle` は `maxDepth: 1`(R4/5 は `'∞'`)。2 ノード循環のみ検出し、foundation レビューアが 3 ノード循環で **0 件** を実証。加えて inline `eslint-disable` 6 箇所 + `reportUnusedDisableDirectives: 'off'`。全グラフの正本は `check_module_boundaries`(Tarjan)なので CI 上の欠落はないが、editor loop としては弱い。新設 `scripts/eslint-import-cycle.test.ts` は `--rule` で depth を上書きするため **plugin の動作は検証するが shipped config は検証しない**。
- `foundation/json → secure-io → audit-chain → (dynamic) audit-forwarder → network → egress-policy → governed-catalog` の 7 ホップ runtime 循環は残存し、`max_runtime_scc_size: 261` の中に居る。方向違反 4 件のうち 2 件は `secure-io [foundation] → audit-chain / tier-guard [domain]`。SX-02/03 の「foundation は core を import しない」は満たしていないことを §7 に書く。
- `no-unused-vars` は 10 ファイル限定のまま(4 ラウンド、未使用 import ≈1,655 本、`media-actuator/src/index.ts` 225/225)。`no-restricted-syntax` は `fs.*Sync` 単一 selector で計画の 3 禁止パターン未実装。
- `module-layer-boundaries.json` の `*-contract.ts` 7 本降格(分類固定で main 84 → 91)と `structured-output-contracts.ts` 二重定義は残存。
- 削除された不変条件コメント 3 件(tier stance / Codex multiAgentMode / narrow-authority-roles)は未復元。voice-hub の非同期委譲 5 関数は `libs/core` に対応物なし(§7 に「廃止」か「再配置予定」かを明記)。

### 領域別の到達点

| 領域                         | 判定              | 残り(先送りとして §7 に明記済み or 要明記)                                                                                                                                                                                         |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| foundation(SX-03)            | 条件付き          | runtime 循環と方向違反 2 件の明記、55 schema、`addFormats`、`ajv2020` dialect、`onFallback` の invalid 時                                                                                                                          |
| 構造(SX-02/12)               | 条件付き          | prologue 剪定、bare importer 762、façade/read-model/state machine 統合、`checks_1/2/3`、`reset*Cache` 86 — **明記済み**                                                                                                            |
| governance/CLI/CI(SX-04〜07) | 承認              | SX-04 後半・SX-06 generator 半分・SX-05 削減目標 — **明記済み**(SX-04 の記述は 96 ファイル移行を過少表記)                                                                                                                          |
| surface(SX-08/09)            | **未達**          | R3 から 4 ラウンド無変更。最低限: thread 履歴重複(discord/telegram)、slack thread ctx 破棄、typing 早期停止、`approval_required` 本番テスト。release 前: concierge `personal` tier、`ALLOW_UNAUTH_REMOTE` 移行注記、middleware XFF |
| 実行層(SX-10/11)             | **承認**          | `core:run_pipeline` 再帰ガード(次に着手推奨)、`core:*` 39、dedup、語彙 — 明記済み                                                                                                                                                  |
| docs(SX-01/13/14)            | approve-with-nits | `KYBERION_ENV_REGISTRY_STRICT` 文書化(operator 影響あり、最優先)、§5 docs 指標の定義、README Glossary リンク、STATUS 1 行                                                                                                          |

## マージ判断

**C1〜C3 を満たせばマージ可**とする。ただし surface 領域は 4 ラウンド一切手が入っておらず、本ブランチの SX-08/09 は「dispatch 統合と SDK 導入」までで、計画の受入基準(bridge −500 行、`as any` 0、意図解釈入口 1)は **未達のまま §7 に明記してマージする**ことを推奨する。分割 PR にする場合は surface 部分を分離して残 20 件を別計画(SX-08b/09b)で扱う。

> 6 ラウンドの総括: 本物の構造的成果 — static cycle 0(lint + checker で二重に固定)、最大 runtime SCC 727→261 を ratchet 化、例外 0 の file-size gate(コード行)、foundation I/O の fail-closed 化、schema 単一ソース + gate/runtime 同形状検証、wrapper 72 件の typed op 化、削除 script 参照 0、voice-hub dispatch 統合、`as_any` 740→610。残る最大の負債は **prologue 複製 1,655 本の未使用 import**、**bare barrel importer 762**、**surface の重複**、そして main 比 **+22.8k 行**。これらは本計画の第 2 期(SX-2 系)として起票し直すのが妥当。
