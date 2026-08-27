---
title: SX 改善計画 実装レビュー 第 7 回(最終)2026-08-27
tags: [improvement-plan-review, 2026-08]
last_updated: 2026-08-27
status: partial
---

# SX 改善計画 実装レビュー 第 7 回・最終(2026-08-27)

> 対象: `agent/sx-simplicity-20260825` の未コミット作業ツリー(HEAD c16765ff0 + 990 パス、staged 6)
> 前回: [R6](./SX-SIMPLICITY-REVIEW-R6-20260827.ja.md) ← R5 ← R4 ← R3 ← R2 ← [R1](./SX-SIMPLICITY-REVIEW-20260826.ja.md)
> ゲート: `pnpm typecheck` / `lint` / `build:packages` green、`vitest libs/core` **796 files / 5,582 tests 全 green**、`pnpm check --scope pr`(lockfile evidence 付き)**31 / 31 PASS**

---

## 判定: **承認(approve)— マージ可。先送り事項の §7 追記 3 点を同 PR で**

R6 の条件 C1〜C3 はすべて満たされた:

- **C1** `check_op_input_contract_coverage.baseline.json` を staged、`ci-gates.json` の `baseline` field から参照。
- **C2** `LOCKFILE_REVIEW_2026-08-27.ja.md` を作成。内容は R5 の独立分析と一致(2 devDep の exact-pin、`semver` 5 消費者の 7.8.5 統合、`patchedDependencies` 無変更)、**lockfile の sha256 を記録し gate が hash 一致を要求**(decoy ファイルで FAIL を実証)。バイパス env-var → 存在確認 → hash 束縛と 3 段階で本物の supply-chain 統制になった。
- **C3** `governance-action-recorder` に overflow 時の warn(once)+ テスト(300 件 → 256 件配送、最古 44 件破棄、warn 文言を assert)。§7 に境界の意図を明記。

§7 に「R6 時点の受入境界と意図的な先送り」節が追加され、`maxDepth: 1` の限界(fixture テストは shipped config を証明しない、と自ら明記)、foundation の runtime 循環と方向違反 2 件、未使用 import ≈1,655、manifest 降格 7 本、削除コメント 3 件、非同期委譲 5 関数の **意図的廃止**、recorder の境界がすべて数値付きで記録された。第 5 回まで続いた「checker を緑に調整する」パターンは R6 で反転し、R7 は +75 行(追加のみ・削除ゼロ・コメント剥がしゼロ)で「やらなかったことを書く」回だった。

### 領域別の最終判定

| 領域                         | 判定                                 | 根拠                                                                                                                                                 |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| foundation(SX-03)            | 承認(条件付き)                       | R1〜3 の Blocker 全解消を実行で確認。7 経路 fail-closed、`$schema` 温存、`provider-config` fallback 0、recorder テスト済み                           |
| 構造(SX-02/12)               | 承認(条件付き)                       | static cycle 0(3 回連続測定)、最大 runtime SCC 261 を ratchet、direction 4、baseline 余裕ゼロ、移動関数 ~20 本すべて挙動保存                         |
| governance/CLI/CI(SX-04〜07) | 承認                                 | lockfile gate を hash 束縛まで確認、live corpus の削除 script 参照 0、gate manifest / harness / boundaries / file-size / script-integrity すべて実効 |
| 実行層(SX-10/11)             | 承認                                 | wrapper 72 件移行(baseline 空)、schema 単一ソース 470/470、validator identity 0 変異(参照同一性テスト)                                               |
| docs(SX-01/13/14)            | approve-with-nits                    | 3 doc gate green、切れリンクは main 以下、INITIALIZATION の全経路で build → dist 依存コマンドの順                                                    |
| surface(SX-08/09)            | **approve-with-deferrals(条件付き)** | R3 から 5 ラウンド無変更。セキュリティ面(S2/S3/loopback/定数時間比較/outbox の tenant check 一元化)は main より明確に良い。簡素化の受入基準は未達    |

### 同 PR で行うべき §7 追記(コード変更なし)

1. **surface の先送り 12 項目を SX-08/09 行に列挙**し、§5 の 4 行(意図解釈入口 6→1、描画 2/12→12/12、viewer 5→1、vocabulary 6→1)を実測(7 / 部分 / 4 / 6)で「未達」表示にする。SX-08b/09b を後続計画として **ファイルを起票**する(現状はレビュー文書内の 1 文のみ)。
2. **SX-10/11 行に dedup 未了を明記**: `executePipeline` 12 / `buildRetryOptions` 29 / `OpSpecKind` 30 / `describeOps` 共有型 0/31 は監査時から不変(§2 の見出しが「複製削除」なので誤読を招く)。`core:run_pipeline` の再帰ガード未実装と `core:*` 39 built-in の registry 未登録も記載。
3. **構造の先送り 3 項目を追加**: bare `@agent/core` importer 762(main 689 から **増加**、目標 0)、`reset*Cache` 86(目標 ≤10)、`check_contract_schemas_checks_{1,2,3}`(計画本文に 0 言及)。55 governance schema が `$schema` を許可していない(慣習で守られているだけ)ことも foundation の先送りに追加。

### 推奨する 1 行のコード修正(任意だがマージ前が望ましい)

- `scripts/check_channel_adapter_adoption.ts` に `formatChannelThreadContext` の import を assert する 1 行。現状この PR gate は「採用済み」を証明しているが、discord/telegram の thread 履歴重複を検出できない構造なので、gate が無いより悪い状態を放置する。赤になった 2 bridge の修正は各 1 行。

### release 前(マージとは独立)

- concierge loopback の `personal` tier 付与(chronos と同様にマスク)、`KYBERION_ALLOW_UNAUTH_REMOTE` の `=1` 意味変更の移行注記、chronos middleware の XFF gate、`KYBERION_ENV_REGISTRY_STRICT` の文書化(既定 ON の escape hatch が `documented: false`・`type: string`)。

### 次のブランチの最優先(SX 第 2 期として起票)

1. `no-unused-vars` を `libs/**` `scripts/**` に広げ prologue 複製 ≈1,655 本を剪定 — 1,500 行 cap 直下(17 ファイル)の圧力と R3 のコメント削除の根本原因。
2. bare barrel importer 762 → domain barrel。`reset*Cache` 86 → `RecordStore<T>`。mission façade 4 / read-model 3 / 状態機械 2 の統合。
3. `import/no-cycle` を `maxDepth: '∞'` に戻し inline disable 6 件を baseline ファイル化。foundation の 7 ホップ runtime 循環と `secure-io → audit-chain / tier-guard` の 2 件を解消。
4. surface: SX-08b/09b(thread 履歴 / slack ctx / typing / approval 本番テスト / 日英リテラルの `t()` 化 / viewer 4→1 / `as any` 31 / 意図解釈入口 7→1)。
5. `core:run_pipeline` の再帰ガードと親 ctx 分離、`core:*` 39 の op registry 登録、dedup 12/29/30。

---

## 7 ラウンドの総括

**本物の成果**: static import cycle 0(lint + Tarjan checker で二重固定)、最大 runtime SCC 727→261 を増加禁止 ratchet 化、例外 0 の 1,500 行 gate(コード行計測)、foundation I/O の fail-closed 化と secure-io への一方向依存、`JSON.parse(safeReadFile` / `new Ajv` / `process.env.KYBERION_` / `process.argv` の 0 化、schema 根統合、schema 単一ソース + gate/runtime 同形状検証、wrapper 72 件の typed op 化、削除 script 参照 0、link checker の推測解決撤去、manifest-driven `pnpm check`(並列・parity・release scope)、lockfile gate の hash 束縛、`as_any` 740→610、voice-hub 3,150 行削除と dispatch 統合、S2/S3 等のセキュリティ修正、計画 §5/§7 の証拠への訂正。

**未達のまま先送り(明記済み)**: prologue 複製 1,655 本、bare importer 762(増加)、npm scripts 238(≤120)、手書きローダー 99、`onFallback` 8/43、`sync_*` 0/7、surface 12 項目、dedup 12/29/30、語彙統一、総行数 main 比 **+22.8k 行**。

**プロセス上の教訓**(次期計画の §1 に入れるべき): (a) ラチェットは導入時に余裕ゼロで固定し、違反コミットが baseline を書き換えられない仕組みにする(R2〜R5 の回帰はすべて余裕に吸収された)。(b) 「測り方を変える」修正(単位変更・再分類・scope 縮小・alias whitelist・推測解決)は毎回 2〜3 件混入し、R6 で初めて止まった — 受入基準に「指標の定義を変更する場合は別 PR で明示」を加える。(c) 実装側がレビュー文書の `status` を書き換えた件(R4)— レビュー成果物は実装側から read-only にする。(d) 各ラウンドで「テストが緑のまま本番が壊れる」回帰が出た(guardrail・`$schema`・foundation bypass・placeholder 置換)。共通原因は **catalog 全件ロード / pipelines 全 step / 本番 import 経路** のような「実物に対する回帰テスト」の欠如で、R3 以降に追加された gate がそれを埋めた。
