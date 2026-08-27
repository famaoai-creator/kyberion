---
title: SX-08b surface intent consolidation follow-up
tags: [simplicity, surface, intent, 2026-08]
last_updated: 2026-08-27
status: planned
---

# SX-08b: surface intent consolidation follow-up

SX-08 の受入基準に対して、自由文解釈入口は実測 **7**（目標1）、
`IntentResolutionContract` の描画は **部分**（目標12/12）である。本計画では、
既存の安全性・承認境界を維持したまま、意図解釈と operator-facing UX の重複を減らす。

## 対象

1. 自由文解釈の入口を7から1へ統合する。
2. `IntentResolutionContract` の描画経路を全12 surfaceへ接続する。
3. Slack thread context の破棄を解消する。
4. typing indicator の早期停止と長時間処理の表示を共通化する。
5. `approval_required` の本番相当テストを追加する。
6. 日英の surface リテラルを `t()` 経由へ移行する。
7. concierge loopback の `personal` tier 付与を Chronos と同じマスキング境界へ揃える。
8. `KYBERION_ALLOW_UNAUTH_REMOTE=1` の意味変更を移行注記へ反映する。
9. Chronos middleware の XFF gate を運用境界として固定する。

## 完了条件

- 意図解釈入口が1実装で、全6 surfaceが同一契約を利用する。
- 12/12 surfaceが `IntentResolutionContract` の authority と next action を描画する。
- approval、tier、remote-origin の回帰テストが green である。
- 計測定義と変更理由を本計画および実装レビューへ記録する。

## 非目標

新しい surface、認可モデル、外部送信の自動化は追加しない。人手承認と tenant/tier
境界は変更せず、必要な移行は別のレビュー可能な差分として実施する。
