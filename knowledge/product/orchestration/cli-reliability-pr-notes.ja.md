---
title: 'CLI Reliability PR — reviewer 向け変更地図と residual'
tags: [cli-reliability, pr-notes, authorship, residuals]
last_updated: 2026-10-31
---

# CLI Reliability PR — reviewer 向け変更地図と residual

branch `feat/cli-reliability-20261031` (base `bfefd82b5`)、計画
`kyberion-reliability-plan.md` の R00–R16 を 16 commit + 設計レビュー 1 commit
で実装したもの。PR body の全文 draft は main checkout 側
`active/shared/tmp/cli-reliability/pr-body-draft.md` (gitignore のため repo 外) —
本書が repo 内の正本としてレビュアに必要な情報を固定する。

## 1. commit → ticket 対応 (16 + 1)

| commit    | ticket                              | 内容                                                                                                                  |
| --------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 424e55b67 | R02                                 | scope-less memory candidate を tenant binding 下で fail-closed (暗黙 public 降格の阻止)                               |
| 2321b0f9b | R03 (+R01 suite +R09 実装、下記 §2) | readiness view と credentialed work の分離 — status 系は reasoning bootstrap 不要、lifecycle verb は deterministic に |
| a2b29a947 | R03 補助                            | `@agent/core/foundation/credential-binding` subpath export                                                            |
| ae5acd48f | R04                                 | listen: media signature 検査 + backend 失敗の5分類 + permission_denied で failover 停止 + path scrub                  |
| 449e8dcca | R05                                 | read エラー分類 + stderr JSON 1文書 contract                                                                          |
| 3ce9e763c | R06                                 | cli-commands に `prerequisites` additive metadata、help に前提と正規導線                                              |
| 055e6aa35 | R09                                 | rank 引数 contract の test 整形 (実装は 2321b0f9b 内)                                                                 |
| 5db8f2c41 | R07                                 | dot status 観測分離 — partial/integrity_error 明示、実行 hydrate は引き続き fail-closed                               |
| 2d94da216 | R08                                 | intent trace を可視 mission のみへ — 不可視 mission で全停止しない・漏洩しない                                        |
| ab1a9b9ba | R10                                 | metrics 集計 identity を component→skill→capability で統一 (`undefined:` 解消)                                        |
| 303f6f69a | R13                                 | home 承認件数を同一 snapshot・同一 bucket 定義で表示                                                                  |
| 97855aebb | R11                                 | doctor repo-build を baseline と同じ入力集合判定へ (unknown を green にしない)                                        |
| 1134d1af4 | R12                                 | `dist/.build-generation.json` receipt + 並行入力変更検出 (`stable_observed`/`changed_observed`/`unverifiable`)        |
| 320eaaa4e | R14 (+R00 fixture)                  | 26 プローブ hermetic process smoke + `probes.json` (期待値は宣言、学習しない)                                         |
| b801f12a4 | R15                                 | CI を fast/integration/clean/native レーンに分割                                                                      |
| ada7b4027 | R16 (+R00 doc)                      | `cli-reliability-runbook.ja.md` + `cli-reliability-baseline.ja.md`                                                    |
| 7214d332e | R12 設計レビュー                    | `build-generation-receipt-review.ja.md` — verdict: approve-with-conditions                                            |

## 2. authorship / sweep の注記 (reviewer 透明性)

`2321b0f9b` (R03) は他 ticket の成果物を取り込んでいる:

- `scripts/context_ranker.ts` の実装 (`parseRankArgs`、positional alias、
  `--limit`/usage 検証、harness `flags: ['json']` による stdout 単一 JSON) は
  **R09** の成果 — R09 自身の commit `055e6aa35` は test 整形のみを保持。
- `tests/confidential-organization-lifecycle.test.ts` は **R01** の contract
  suite で、R03 の変更がその `it.fails` を実 assertion に転じる。

内容は完全で、2 名のエージェントの成果が 1 commit に同居するだけである。
ticket 対応は commit title ではなく commit body の R0x marker で読むこと。

## 3. residual (merge 判断で必要なもの)

1. **R12 receipt schema**: 設計レビュー完了 (`build-generation-receipt-review.ja.md`) —
   verdict **approve-with-conditions**。C1 = focused provenance test + full
   `pnpm run ci` が clean lane で通ること。
2. **full `pnpm run ci` 未実行**: この worktree では ticket 別 focused test のみ。
   「CI 検証済み」とは呼ばない。merge 前に `pnpm check -- --scope pr` + `pnpm run ci` 必須。
3. **P09/P25 real backend**: Apple Vision OCR / 実 STT backend の正常系は R15
   macOS native lane へ defer。hermetic smoke は「分類される拒否」の境界を
   証明するのみで、実 transcript/OCR 成功を主張しない (env-blocked と表示)。
4. **R04 permission_denied residual**: 永続 tenant scope の `kyberion listen`
   で STT backend が confidential scratch (`active/shared/tmp/confidential/<tenant>/perception/`)
   を読む経路は、現状 identity に governed grant が無ければ正しく `permission_denied`
   で停止する。橋渡し自体は設計ノート `listen-confidential-scratch-bridge.ja.md` に
   保留 — security-policy / role-assumption の判断が必要で、この PR では実装しない。

## 4. 「完了と言わない」条件 (計画 §9 との照合)

- confidential 正常系は hermetic contract test (`tests/confidential-organization-lifecycle.test.ts`)
  で固定済みだが、**実 tenant ledger を使った end-to-end 再現は未実施** — 合成 fixture 合格と
  本番運営完成を混同しない。
- 26 プローブのうち live 環境依存ケース (P09/P25) は env-blocked。report の
  17/9 と raw log 14/12 の差分は probes.json の classification/expectation_revision に記録。
- exit code は現行契約 (doctor=1, vital=3, 一般=1) を文書化したのみで一括変更していない。

## 5. Knowledge セクション (PR template 必須)

PR body の `## Knowledge` は **mission distill の memory candidate をここへ宣言する
placeholder**。`memory-promote --target-root <worktree>` の対象候補を finish 前に列挙し、
`promoted:`/`rejected:`/`routed:`/`none — <reason>` のいずれかで埋めること
(local gate KL-03 が空セクションをブロックする)。
