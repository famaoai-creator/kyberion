---
title: Blueprint: Design Clone Request Intake
category: Templates
tags: [templates, blueprints, design, intake, web, mobile]
importance: 7
author: Kyberion
last_updated: 2026-03-21
---

# Blueprint: Design Clone Request Intake

この intake は、次の依頼をそのまま受けるための標準テンプレートです。

> このアプリのデザインを踏襲して、こういうコンセプトのサイト/アプリを作って。設計書とテスト結果も出して。

## 1. Request Summary

- **Platform**: `web` / `mobile`
- **Reference Source**: URL, app name, repository, screenshot set, or binary
- **New Concept**: 何を新しく作るか
- **Primary Audience**: 誰のための体験か
- **Target Outcome**: どこまで作るか

## 2. Preserved Design Elements

- **Visual Language**: 色、余白、タイポグラフィ、密度、トーン
- **Interaction Style**: 遷移感、入力感、モーション、情報配置
- **Information Architecture**: 踏襲したい画面構成や navigation
- **Components To Reuse**: button, card, table, tabs, forms など
- **Do Not Copy**: 踏襲しない要素

## 3. Product Concept

- **Problem To Solve**: 何の課題を解くか
- **Core Scenario**: 代表ユーザーフロー
- **Required Screens / Routes**: 最低限必要な画面
- **Authentication**: あり / なし
- **Data Sensitivity**: public / confidential / personal

## 4. Delivery Scope

- **Implementation Scope**:
  - prototype
  - implementation slice
  - end-to-end deliverable
- **Platforms**:
  - browser only
  - android
  - ios
  - hybrid
- **Output Format**:
  - source code
  - skeleton
  - design spec
  - test result pack
  - presentation materials

## 5. Test & Evidence Scope

- **Required Test Level**:
  - smoke
  - major flows
  - route/state coverage
  - regression-ready
- **Required Evidence**:
  - screenshots
  - session handoff artifacts
  - ui-flow-adf
  - test-case-adf
  - execution logs

## 6. Execution Environment

- **Web Runtime**: local dev server / staging / production mirror
- **Mobile Runtime**: emulator / simulator / physical device
- **Debug Hooks Available**: yes / no
- **Session Export Available**: yes / no
- **Build Access**: source available / binary only / partial

## 7. Standard Output Pack

推奨の納品物:

- requirements definition
- detailed design
- architecture design
- app profile
- `ui-flow-adf`
- `test-case-adf`
- execution plan
- test validation report

## 8. Intake Completion Gate

この intake は、次が埋まれば execution に進めます。

- platform
- reference source
- preserved design elements
- new concept
- delivery scope
- execution environment
