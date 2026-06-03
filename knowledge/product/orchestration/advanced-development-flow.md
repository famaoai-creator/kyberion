---
title: 高度な自律開発標準ワークフロー (Advanced Development Flow)
category: Orchestration
tags: [orchestration, advanced, development, flow, security]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# 高度な自律開発標準ワークフロー (Advanced Development Flow)

Kyberion エコシステムが「最高品質」のプロダクトを自律生成するための標準手順。

## 1. 計画・定義フェーズ (Define)

- **`requirements-wizard`**: IPA準拠の要件定義を実施。
- **`ux-auditor` & `layout-architect`**: プロトタイプ作成前にUI/UX方針とデザインシステムを定義。

## 2. 開発フェーズ (Implement - TDD Mandatory)

- **`test-suite-architect`**: 実装前に失敗するテスト（Red）を生成。
- **`test-genie`**: 最小実装後にテストを実行（Green）。
- **`refactoring-engine` & `aesthetic-elegance-auditor`**: コードの品質と美しさを最適化（Refactor）。
- **`coverage-monitor`**: カバレッジ 80% 以上を機械的にチェック。

## 3. 検証・品質監査フェーズ (Verify)

- **`browser-actuator` & `vision-actuator`**: ブラウザ操作と視覚確認を組み合わせた E2E 検証。
- **`code-actuator` & `secret-actuator`**: governed code analysis と secret hygiene による最終スキャン。
- **`orchestrator-actuator`**: quality gate を束ね、証跡を mission contract に残す。

## 4. 納品・デリバリー (Deliver)

- **`pr-architect` & `release-note-crafter`**: 変更の意図とビジネス価値を言語化。
- **`ppt-artisan`**: 戦略的プレゼンテーション（SVG図解・ブランドテーマ適用）の自動生成。
