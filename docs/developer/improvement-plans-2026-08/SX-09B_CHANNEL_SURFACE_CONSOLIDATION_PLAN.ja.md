---
title: SX-09b channel surface consolidation follow-up
tags: [simplicity, channel-adapter, surface, 2026-08]
last_updated: 2026-08-27
status: planned
---

# SX-09b: channel and viewer consolidation follow-up

SX-09 の現状は4 bridgeの `ChannelAdapter`/`runChannelTurn` 移行まで完了しているが、
viewer/auth は実測 **4**（目標1）、vocabulary lookup は **6**（目標1）である。
本計画では、provider固有の配送を保ったまま、履歴・権限・語彙の重複を整理する。

## 対象

1. Discord/Telegramの thread 履歴重複を解消する。
2. viewer/auth 実装を4から1へ統合する。
3. channel vocabulary lookup を6から1へ統合する。
4. bridge に残る `as any` **31** 件を型付き境界へ置換する。
5. Slack thread context を共通 formatter へ揃える。
6. typing、approval、proposal の共通 delivery gate を本番相当テストで固定する。
7. 日英の channel リテラルを `t()` 経由へ移行する。
8. viewer scope と tenant scope の表示・認可責務を一本化する。

## 完了条件

- 4 bridgeが共通 thread formatter と delivery gate を利用し、履歴が二重投入されない。
- viewer/auth と vocabulary の正本が各1実装で、全bridgeがそれを利用する。
- `as any` の残件を0にし、provider固有型は adapter 境界に閉じ込める。
- tenant scope、approval、external delivery の回帰テストが green である。

## 非目標

provider APIの置換や配送仕様の変更は行わない。外部送信は既存の人手承認・明示的な
`shouldSend` gateを維持し、release前のloopback/XFF移行はSX-08bと協調して別検証する。
