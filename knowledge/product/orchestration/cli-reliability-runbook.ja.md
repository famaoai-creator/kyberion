---
title: CLI 信頼性ランブック — 症状から正規復旧まで
tags: [cli-reliability, runbook, recovery, r16]
last_updated: 2026-10-31
---

# CLI 信頼性ランブック (R16)

順序は常に: **症状 → 安全な read-only 診断 → 原因分類 → 正規 owner/setup/claim 経路 → 同一 scope で再開 → 確認**。
環境変数の消去・hard reset・dist 一括削除・operator/public への退避は**推奨手順に含めない** (危険な回避策であり、失敗例との区別を下表に明記)。

## 安全な診断コマンド (すべて read-only / readiness)

| 目的                     | コマンド                                                          | 備考                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 全体の健全性             | `pnpm kyberion doctor`                                            | attention は exit 1=正常。`undefined:` 行は R10 で修正済み                                                                               |
| readiness (binding 不要) | `pnpm kyberion calendar status` / `email status` / `list --check` | R03 以降、reasoning bootstrap・credential 解決なしで exit 0。`credential_binding.status` が `bound`/`binding_required`/`operator` を返す |
| 台帳観測                 | `pnpm kyberion dot status`                                        | R07: partial/integrity_error を表示。実行は依然 strict fail-closed                                                                       |
| 相関 ID 照会             | `pnpm kyberion intent trace <correlationId>`                      | R08: 可視 scope のみ探索。自然言語引数は INVALID_INPUT で拒否                                                                            |
| 異常系再現               | `pnpm exec vitest run tests/cli-reliability.smoke.test.ts`        | hermetic fixture、実 tenant 不変                                                                                                         |
| build 世代               | `pnpm run check` の repo-build / `dist/.build-generation.json`    | R11/R12: mtime ではなく入力集合+receipt で判定                                                                                           |

## 原因分類 → 正規経路

| 分類                             | 兆候                                 | 正規経路                                                                                                                                  |
| -------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| invalid_input                    | 拡張子だけの偽メディア、引数契約違反 | 実ファイルを `active/shared/tmp/<job>/` へコピー、正しい引数形で再実行                                                                    |
| not_found / outside_scope        | repo 内 missing / 範囲外パス         | 認可済み領域のパスを確認。範囲外は存在を開示せず拒否されるのが仕様                                                                        |
| binding_required                 | tenant scope 配下で live 操作        | WorkItem claim → `mission dispatch-workitems` 経由の正規 dispatch。`status`/`latest-draft`/`list --check` は binding 不要の readiness     |
| backend_missing / assets_missing | STT backend・model assets 未導入     | `voice setup` / assets 導入後に同一 scope で再試行。実機検証は R15 native lane                                                            |
| permission_denied                | ROLE_VIOLATION・scope 不一致         | 元 scope のまま、所有 scope の承認経路で復旧。public 退避禁止                                                                             |
| partial / integrity_error        | dot/intent の壊れた行                | 観測は継続。修復は review 済み migration / owner 確認 (`dot migrate-state` は legacy 採用を review 後にのみ)。status で台帳を書き換えない |
| stale_build / building / unknown | repo-build 判定                      | `pnpm run build` を再実行。building は観測延期 — 自動 repair 連打しない                                                                   |

## F1–F9 対応表 (case ID / ticket / test / 残余)

| Finding                         | probe       | fix        | test                                       | 残余                                                                      |
| ------------------------------- | ----------- | ---------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| F1a 偽 WAV→生 ffmpeg            | P10         | R04        | smoke P10 + `input_invalid` marker         | なし                                                                      |
| F1b 中間ファイル ROLE_VIOLATION | P25         | R04        | smoke P25 (classified denial)、native lane | 実機 backend 正常系は macOS lane 要検証                                   |
| F2 外部パス存在 oracle          | P21         | R05        | smoke P21 + S02                            | なし                                                                      |
| F3 status が binding 必須で死亡 | P22/P23/P26 | R03        | smoke + credential-binding tests           | status の JSON 形状は additive                                            |
| F4 doctor=1/vital=3 非対称      | P01/P02     | 契約文書化 | smoke allowed_exits                        | exit 意味論の統一は別レビュー                                             |
| F5 dot/intent 全滅              | P19/P24     | R07/R08    | smoke + ledger/trace tests                 | integrity_error 行の修復は owner 確認必要                                 |
| F6 home 件数二重                | P05         | R13        | operator-home-summary tests                | 解消済みは lockfile WARN (環境ノイズ); 未解決は件数バケット表示の名称統一 |
| F7 rank positional 拒否         | P11         | R09        | smoke P11 + context_ranker tests           | なし                                                                      |
| F8 doctor `undefined:`          | P01         | R10        | metrics tests                              | なし                                                                      |
| F9 stale 13 秒偽陽性            | (doctor)    | R11/R12    | build-readiness/build provenance tests     | A→B→A 中間変更は検出限界 (receipt は stable_observed と正直に記録)        |

## 危険な回避策 (失敗例として記録 — 推奨しない)

- `KYBERION_*` scope env を消して tenant なし扱いにする → 元 scope を失い、binding/claim の証跡を破壊する
- `active/` や `dist/` の一括削除・hard reset → ledger 証跡喪失
- operator scope / public tier で実行して「通った」とする → 本計画の不適格条件
- 検証は: 同一 tenant/org/project/tier で intake→claim→dispatch→verify→distill→finish→同 scope 再利用 (tests/confidential-organization-lifecycle.test.ts) と smoke 26 件が fixture 内で再現すること
