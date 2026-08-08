---
title: QM残作業レビュー 2026-08-08
tags: [improvement-plan, qm, review, residuals]
last_updated: 2026-08-08
---

# QM残作業レビュー

## 判定

今回の残作業について blocking finding は 0。実装・検証可能な範囲は完了し、外部CLIの未導入とモデルターンを伴う適合項目は証跡上で `unavailable` / `declared` として分離した。

## 実装した残作業

- QM-03: `memory_consolidation` を background-review の候補保存、承認要求、現行ハッシュ照合、バックアップ付き適用へ接続。
- QM-05: shell 承認キャッシュの action descriptor を `rule:<matchedRuleId>` 単位へ正規化。実payloadのhash bindingは維持。
- QM-06: `backend-conformance.ts` と `check:backend-conformance` を追加。CLI version/helpの実probe結果を `evidence/QM-06-CLI-MATRIX-20260808.json` に保存。
- QM-08: onboarding wizard と `onboard:apply` が runbook `SKILL.md` と provenance sidecarをprofile配下へ生成。

## 検証

- 残作業対象テスト: 12 tests passed。
- background-review、shell policy、agent governance、onboarding apply、backend conformance: 65 tests passed。
- `tsc --noEmit`、core package build、live CLI version/help probeを実行。
- copilot CLIは実行環境に存在せず、matrixでは `unavailable` と記録した。
