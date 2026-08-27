---
title: adf-replay-extension 統合レビュー 2026-08-10
kind: review-report
scope: tools/adf-replay-extension, scripts/browser_bridge_host.ts, libs/core/browser-extension-bridge.ts
status: active
owner: ecosystem_architect
reviewed_at: 2026-08-10
tags: [browser-bridge, chrome-extension, intent-loop, self-repair, pii, i18n]
last_updated: 2026-07-31
---

# adf-replay-extension 統合レビュー

## 結論

別途開発されていた `tools/adf-replay-extension/` の Built-in AI 機能を、既存の
Native Messaging / browser-recording / intent 解決 / self-repair の導線へ取り込んだ。
AI の出力は候補と要約に限定し、ADF、selector、lease、approval の権限を持たせていない。

## 取り込み内容

- redaction 済みページ本文・対象候補を content script から Side Panel へ渡す。
- Built-in AI のシナリオ候補を確認後に intent 入力へ設定できるようにした。そこから既存の
  Pattern B（照合・承認・実行）または Pattern A（記録・Review）へ進む。
- 既存 content script の再接続時も `bridge:ping` の PII scrubber 状態を確認し、必要な場合は
  generated rule だけを再注入する。content script の二重宣言は行わない。
- AI の入力と出力の両方を generated PII rule で処理し、repair 候補の index は候補配列の範囲内
  だけを採用する。
- 拡張契約テストを `pnpm run test:browser-bridge` から実行できる入口を追加した。

## レビュー結果

| 軸            | 判定                         | 確認内容                                                                                                                                                                                     |
| ------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| セキュリティ  | PASS                         | AI は Side Panel 内のローカル API のみ。ページ文を命令として扱わず、AI 出力だけで操作・承認・実行しない。Native host の lease / approval 境界は既存経路を維持。                              |
| intent→改善   | PASS                         | 候補→intent→既存照合または新規記録→Review→preflight→lease→receipt→観測/repair の接続を確認。repair 候補は自動適用せず、修正記録と Review を要求。                                            |
| PII           | PASS                         | generated rule の注入順、入力・出力の再 scrub、query/fragment を除いた URL、候補上限を確認。                                                                                                 |
| i18n / UX     | PASS（内部拡張の現行方針内） | 新しい操作説明・失敗時案内は日本語。Chrome API 名などの技術名は固有名として残した。拡張は国際化計画上の内部ツール対象外候補であるため、中央 UI 翻訳 catalog への無理な依存は追加していない。 |
| extensibility | PASS                         | `browser-recording.v1` と Native Messaging の既存契約を変更せず、AI は review 補助アダプタとして分離。API 非対応時も既存録画・実行経路を継続できる。                                         |
| 実機運用      | PARTIAL                      | Chrome の実 Built-in AI availability / モデル取得と Native host install は端末依存のため、CI の hermetic test だけでは完了しない。手動の Chrome unpacked load と host install を別途行う。   |

## 検証証拠

- Browser Bridge extension / accessibility / Built-in AI: 3 files, 26 tests passed
- Browser extension core contracts / promotion / self-repair: 3 files, 56 tests passed
- `node --check`（background / content / sidepanel / built-in-ai）: passed
- `tsc --noEmit`: passed
- `check:pii-rules`: passed
- Prettier check / `git diff --check`: passed

## 残課題

1. Chrome 実機で Built-in AI のモデル取得、ページ権限、Native host lease、approval_required、receipt
   送信までを通す E2E は別の実機検証として残る。
2. 内部拡張を第三者向け配布物へ昇格する場合は、中央 i18n catalog への移行と Chrome API の
   ロケール別メッセージ契約を追加する。
