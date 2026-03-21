---
title: Design Clone And Build Mobile
category: Procedures
tags: [procedures, service, mobile, design, build, test]
importance: 9
author: Kyberion
last_updated: 2026-03-21
---

# Design Clone And Build Mobile

対象依頼の典型形:

> このモバイルアプリのデザインを踏襲して、こういったコンセプトのアプリを作成して。設計書とテスト結果など必要なドキュメント成果物も出力してください。

## Goal

既存モバイルアプリの visual/system/interaction を観察し、その意匠と画面遷移の性格を踏襲しつつ、新しいコンセプトに沿ったモバイルアプリ案または実装骨格を構築し、設計書・試験項目・テスト結果・成果物パックまで出す。

## Current Feasibility

`mobile` は条件付きで実現可能です。

既存資産:

- Android Actuator
- iOS Actuator
- `mobile-app-profile`
- mobile-to-WebView session handoff
- app-side debug adapter template
- mobile sample skeleton

現時点で強いこと:

- 既存 app の観察
- selector/profile 化
- debug build 前提の主要動線試験
- skeleton 生成
- 設計書/試験項目生成

制約:

- production-ready native 実装の自動完成度はまだ限定的
- 実機差分や platform-specific polish は別途必要
- debug/export hook が無いアプリでは認証 handoff が弱くなる

## Input Contract

最低限ほしい入力:

1. 参照元アプリ
2. 対象 platform
3. 踏襲したい要素
4. 新アプリのコンセプト
5. 対象画面と主要動線
6. debug build / simulator / emulator の有無
7. 出したい成果物

## Recommended Flow

1. 参照元観察
2. selector/profile 抽出
3. design/interaction 観察結果を設計へ反映
4. `mobile-app-profile` 作成
5. skeleton 生成または既存 app 改修
6. `ui-flow-adf` 作成
7. `test-case-adf` 生成
8. Android/iOS actuator 実行 plan 作成
9. debug build で試験
10. 成果物パック出力

## Actuator Mapping

- Android:
  `android-actuator`
- iOS:
  `ios-actuator`
- WebView handoff:
  `browser-actuator`
- route/test modeling:
  `modeling-actuator`
- 設計/報告資料:
  `media-actuator`

## Output Pack

最低限の納品物:

- requirements definition
- detailed design
- architecture design
- `mobile-app-profile`
- debug adapter integration note
- sample skeleton or implementation slice
- `ui-flow-adf`
- `test-case-adf`
- actuator execution evidence
- test validation report

## Success Criteria

- 参照元アプリの踏襲対象が明文化されている
- 新アプリの画面/遷移/主要 UX が設計化されている
- `mobile-app-profile` が生成されている
- debug or simulator 前提で主要動線のテスト結果がある
- 設計書とテスト結果が成果物として保存されている
