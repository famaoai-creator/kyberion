---
title: CLI 信頼性ゲート — CI レーンマップ
tags: [ci, cli-reliability, gates, r15]
last_updated: 2026-10-31
---

# CLI 信頼性ゲート (R15)

26 プローブ (tests/fixtures/cli-reliability/probes.json) と P0 confidential
lifecycle を、目的別レーンに分離して CI に固定した。exit 0 を全部に求めない —
expected-denial / expected-attention / env-blocked は契約に一致すれば合格、
緑になっただけの retry で隠さない。

## レーン対応表

| レーン       | 実体 (workflow / job / step)                                                                | 内容                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fast         | pr-validation.yml `pr-gates` + `static-checks`                                              | `pnpm run check -- --scope pr` (manifest/schema・境界 test・help JSON 契約の単体 test を含む)、typecheck/lint/format。変更単体 test は既存 shard                                                                                                                                 |
| integration  | pr-validation.yml `cli-reliability`                                                         | `node scripts/kyberion_cli_entry.mjs --help` (bootstrap なし exit 0)、`pnpm exec vitest run tests/cli-reliability.smoke.test.ts` (built-CLI 26 プローブ hermetic process smoke)、`pnpm exec vitest run tests/confidential-organization-lifecycle.test.ts` (P0 scope 正常系+負例) |
| clean        | ci.yml `build-artifacts` → `lint-and-validate` → `test`、pr-validation `build-artifacts` 他 | 専用 checkout・frozen lockfile (setup-kyberion)・build→typecheck→check→test。共有 checkout の dirty source は CI 根拠にしない                                                                                                                                                    |
| macOS/native | cross-os.yml `build-and-smoke` → `Native perception canary (macOS, opt-in backend)`         | 合成 WAV を生成し、実 local STT backend が存在する時だけ `kyberion listen` を実行。capability が無ければ `::notice::env-blocked:` を出して明示 skip — Linux mock 合格を Apple 実機合格と呼ばない                                                                                 |

## 証跡と分類

- integration lane は artifact `cli-reliability-evidence` に `sha / lockfile_sha256 /
dist/.build-generation.json / fixture schemaVersion / git status` と
  first-run の smoke/lifecycle ログを添付する (retry で初回結果を消さない)。
- 失敗分類: `bug` (契約違反) / `expected-denial`・`expected-attention` (probes.json
  分類一致で fail としない) / `env-blocked` (native/backend 未導入 — pass ではない)
  / `flaky` (再現しない; quarantine は根拠付き期限・レビュー制)。
- env-blocked ケースは vitest `skip` で報告され、`P09-see-image reports
env-blocked` のように理由が名前に出る。
- artifact 内の stdout/stderr は fixture env (秘密値なし) + harness の secret
  guard redaction 前提。本番 secret を fixture/env に流し込まない。

## 変えてはいけない既存ゲート

- `pr-gates` (check --scope pr)、core/actuators shard、boundary tests、
  mission:residue、check:commit-subject、vital-check — すべて required のまま。
  smoke 追加は既存 job の弱体化・optional 化を伴わない。
- `expected-denial` を「緑にするため skip」にしない: probes.json の
  `expected_outcome`/`allowed_exits` への変更は expectation_revision 必須。

## 関連

- probes.json `smoke_contract` — per-case launcher/timeout/side_effects/marker
- tests/support/cli-reliability-harness.ts — fixture root 隔離機構
- knowledge/product/orchestration/cli-reliability-runbook.ja.md — 障害時の正規復旧
