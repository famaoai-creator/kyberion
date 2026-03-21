---
title: Design Clone And Build Web
category: Procedures
tags: [procedures, service, web, design, build, test]
importance: 9
author: Kyberion
last_updated: 2026-03-21
---

# Design Clone And Build Web

対象依頼の典型形:

> この Web アプリのデザインを踏襲して、こういったコンセプトの Web サイトを作成して。設計書とテスト結果など必要なドキュメント成果物も出力してください。

## Goal

既存 Web アプリの visual/system/interaction を観察し、その意匠を踏襲しつつ、新しいコンセプトに沿った Web サイトを構築し、設計書・試験項目・テスト結果・成果物パックまで出す。

## Current Feasibility

現時点の Kyberion では、これはかなり現実的です。

既存資産:

- Browser-Actuator による観察、snapshot、session export/import
- `web-app-profile`
- `ui-flow-adf`
- `test-case-adf`
- Browser execution plan 生成
- Web sample app skeleton

不足が少ないため、`web` は end-to-end に近い。

## Input Contract

最低限ほしい入力:

1. 参照元 Web アプリ URL またはデザインソース
2. 踏襲したい要素
3. 新サイトのコンセプト
4. 必須ページ
5. 認証の有無
6. 出したい成果物

## Recommended Flow

1. 参照元観察
2. visual language 抽出
3. route/guard 抽出
4. `web-app-profile` 作成
5. `ui-flow-adf` 作成
6. 新サイト構築
7. `test-case-adf` 生成
8. Browser execution plan 生成
9. テスト実行
10. 成果物パック出力

## Actuator Mapping

- 参照元観察:
  `browser-actuator`
- route/test modeling:
  `modeling-actuator`
- 実装:
  repo editing flow
- 設計/報告資料:
  `media-actuator`

## Output Pack

最低限の納品物:

- requirements definition
- detailed design
- architecture design
- generated Web app source
- `web-app-profile`
- `ui-flow-adf`
- `test-case-adf`
- Browser execution plan
- test validation report

## Success Criteria

- 参照元デザインの再現方針が明文化されている
- 新サイトの主要 route が実装されている
- `ui-flow-adf` と `test-case-adf` が生成されている
- Browser-Actuator による主要動線の試験結果がある
- 設計書とテスト結果が成果物として保存されている
