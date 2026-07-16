---
title: Browser Actuator browser-cli 概念昇華計画
kind: improvement-plan
scope: browser-actuator
authority: execution
status: phase-3-complete
---

# Browser Actuator browser-cli 概念昇華計画

## 方針

`browsemake/browser-cli` はコードとして取り込まない。Express daemon、無認証 HTTP、任意 URL 遷移、グローバル profile、非有界 history、秘密値の記録を採用せず、操作概念だけを既存の Playwright/lease/Trace 契約へ昇華する。

## 対応表

| 概念                      | canonical 契約                                             | 状態                                                           |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| view-tree / element id    | `snapshot + ref`                                           | 実装済み。viewport、focus、password 値 redaction を追加        |
| scrollIntoView / scrollTo | `scroll_ref` / `scroll`                                    | 実装済み。delta は上下限を適用                                 |
| fill-secret               | `fill_secret_ref`、`fill_ref` の `secret_ref`              | 実装済み。SecretResolver を使用し trail に値を記録しない       |
| history                   | `action_trail` capture                                     | 実装済み。200 件を標準上限、session artifact として保存        |
| health / tabs             | `session_health`、既存 `tabs`                              | 実装済み。lease、CDP、tab、event 件数を返す                    |
| replay/export             | `export_adf`、`export_playwright`、`export_failure_bundle` | 実装済み                                                       |
| operator pause            | `pause_for_operator`                                       | 実装済み。pending/approved/expired を approval artifact に保存 |
| 任意 URL                  | navigation policy gate                                     | 実装済み。未許可 origin と private/loopback を拒否             |

## Phase 1-3 の完了条件

- [x] navigation policy を `goto`/`open_tab` の両経路で適用
- [x] SecretResolver 経由の secret fill と trail/snapshot redaction
- [x] lease/session health と bounded action trail
- [x] failure bundle に snapshot/screenshot/trace/console/network/trail を集約
- [x] `extract_text_ref`、`scroll_ref`、`scroll` を canonical op として登録
- [x] snapshot の semantic state（viewport/focus/ready state）を公開
- [x] operator pause を structured approval として記録
- [x] Trace event に ref/redaction/approval 状態を付与
- [x] op contract、schema、registry、targeted tests を同期

## 次の保留項目

- DNS 解決後の private network 検査（現在は literal host/IP と origin allowlist）
- Chronos Mirror v2 の専用 browser session パネル
- replay procedure の UI 表示
- browser-cli 互換 adapter（必要性が確認できた場合のみ）

## 検証

```text
pnpm exec vitest run libs/actuators/browser-actuator/src/browser-phase3.test.ts \
  libs/actuators/browser-actuator/src/index.test.ts \
  libs/core/op-input-contracts.test.ts \
  tests/computer-interaction-contract.test.ts
pnpm run typecheck
pnpm run validate
```
