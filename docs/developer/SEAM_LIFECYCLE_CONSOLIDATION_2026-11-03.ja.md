---
title: seam ライフサイクル・選択・provider 境界の共通化
tags: [refactoring, seam, provider, lifecycle, architecture]
last_updated: 2026-11-03
status: implemented
---

# seam 共通化の調査と実装対応

基準は `4272c2997` (2026-11-03)。既存の
[seam dispatch 統一計画](./improvement-plans-2026-09/SEAM_DISPATCH_UNIFICATION_PLAN_2026-09-28.ja.md)
と [seam provider selection](../../knowledge/product/architecture/seam-provider-selection.md)
を継承する。新しい registry や認可経路は追加せず、既存 seam の採用を揃える。

## 調査結果と受入条件

| ID    | 調査で確認した問題                                                                                                                      | 実装・受入条件                                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-01 | disposer/reset 管理が各 bridge に複製され、OCR は解除時に router cache を無効化しない。mock provider は一覧から消えた後も再実行された。 | `createSeamLifecycle` に登録・解除・reset を集約。派生 cache は登録と解除の両方で無効化し、解除済み provider を次回の処理で呼ばない。          |
| SC-02 | 検索・ブラウザの `auto` は適合候補を `find()` で選び、複数候補の ID 辞書順が暗黙の優先順位になる。                                      | 共通の auto resolver を使う。明示された既定 ID または唯一の適合候補で解決し、他は曖昧性エラー。restricted provider の opt-in 制約を維持する。  |
| SC-03 | Streaming STT の `stub` は catalog 未登録でも一覧と get に現れ、同じ ID の登録実装を無視する。                                          | builtin stub を通常登録し、catalog/list/get の対象を一致させる。reset 後に builtin を復元し、二重登録は既存 seam の規則で拒否する。            |
| SC-04 | 共通の選択エンジンに入る条件が各ドメインに分散。OCR の通常経路と purpose 経路が適格性を別々に判定する。                                 | `resolveSeamSelectionEntry` が explicit/default/purpose/rule/fallback の入口を統一する。OCR は単一の hard-eligibility 判定を両経路で使用する。 |
| SC-05 | OCR・画像生成・音楽生成の bridge に契約・registry・routing・具体 provider・builtin 組立が混在する。                                     | 具体 provider を専用モジュールへ分離。registry/router は具体実装に依存せず、compatibility facade は既存の公開 API を re-export する。          |
| SC-06 | multiplicity/AST 検査は通るが、解除後の解決や catalog と実行対象の一致を検査しない。                                                    | lifecycle/auto 解決の共通契約テストと3件の不整合の回帰検査を追加。既存の宣言検査も維持する。                                                   |

## 境界と互換性

- seam は契約と登録機構、adapter は具体実装、resolver は適格候補の選択、facade は組立と公開 API を担当する。
- 明示 provider 指定は選好より優先するが、egress・training use・identity・capability の制約を緩めない。
- 言語、端末、アカウント、課金、host handoff の可否は domain の適格性判定に残す。
- policy の順位計算・mission pin・監査は既存の `resolveSeamProviderDecision` を使う。
- domain の reset 時に復元する builtin は、その composition が所有する。共通 lifecycle は domain の default を決めない。
- private identity/onboarding データは gitignored な personal 領域に保持し、調査資料や product knowledge に転記しない。

## 検証方針

1. 共通契約: 二重登録、解除の冪等性、古い disposer、reset、変更通知、auto の一意性と既定値。
2. 回帰: OCR の解除後呼出し、検索の複数適合候補、Streaming STT の catalog/list/get/reset。
3. 選択: explicit 指定、非一致 rule、purpose、default eligibility、fallback、pin と監査を既存テストと合わせて確認。
4. 境界: core package build、root typecheck、module-layer/registration、seam multiplicity/AST と PR scope の共通 gate。

実行結果は本書の検証記録と mission `MSN-SEAM-CONSOLIDATION-20261103` の evidence に記録する。
未実行・失敗した検査を成功と扱わない。

## 実装と検証記録

SC-01〜SC-06 は実装済み。OCR は `libs/core/ocr/`、画像・音楽生成は
`libs/core/media/{image-generation,music-generation}/` に registry、router、builtin composition、
具体 provider を分離した。旧 bridge の公開 exports は compatibility facade に残す。

- `pnpm build:packages`、`pnpm build:repo`、`pnpm typecheck` は成功。
- 最終の seam・OCR・画像・音楽・音声・ブラウザの一括検証は31ファイル・407テスト成功。登録通知中の reset、解除後の cache、画像の外部効果承認境界を含む。
- 独立した静的レビューは指摘ゼロ。登録通知中の reset に関する提案は、世代追跡と回帰テストで対応した。レビュー担当者はテストを実行していない。
- PR scope の初回検査は51件中50件成功。残る AST 検査が音楽生成 seam の catalog/生成図への未登録を検出したため、読み込みと role map を追加した。修正後、multiplicity と AST はともに55件で成功した。
- 共通契約・provider 境界・OCR 回帰検査を `ci-gates.json` の `registration-tests` に追加した。修正後の `pnpm check -- --scope pr` は **51件すべて成功**。詳細は mission evidence に保存する。
