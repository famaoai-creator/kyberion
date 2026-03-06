---
title: SLO & Dashboard Best Practices
category: Operations
tags: [operations, slo, dashboard, best, practices]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# SLO & Dashboard Best Practices

サービスの信頼性を定量化し、ビジネスと開発の意思決定を一致させるためのガイドラインです。

## 1. SLO / SLI の定義と運用

- **SLI (Service Level Indicator)**: ユーザー体験に直結する定量的な指標（可用性、レイテンシ、成功率など）。
- **SLO (Service Level Objective)**: SLIが維持すべき目標値。
  - **Do not aim for 100%**: 100%の信頼性は不可能であり、イノベーションを阻害します。
  - **User-Centric**: システムの内部メトリクスではなく、ユーザーの主要なジャーニー（ログインできるか、購入できるか等）を測定します。
  - **Internal vs External**: 内部SLOは外部向けSLA（Service Level Agreement）よりも厳しく設定し、警告のバッファを持たせます。

## 2. Error Budget (エラー予算) の活用

- **Definition**: 100% - SLO。許容される不具合やダウンタイムの総量。
- **Policy-Driven Action**:
  - **Budget Remaining**: 新機能のデプロイや実験を積極的に行います。
  - **Budget Exhausted**: 新機能の開発を一時停止し、システムの安定化、テクニカルデットの解消、テストの改善にリソースを集中させます。
- **Burn Rate Alerting**: 「予算が何分で尽きるか」という燃焼率に基づいたアラートを設定し、数時間〜数日後の予算枯渇を予見して対応します。

## 3. Dashboard 設計の原則

- **Clarity of Purpose**: ダッシュボードの目的（リアルタイム障害検知、長期傾向分析、経営層報告など）を明確にします。
- **Consistent Visual Language**:
  - **Color Coding**: 緑（正常）、黄（警告）、赤（異常）を統一します。
  - **Layout**: 重要な情報（SLO達成率、現在のアラート）を左上に配置します。
- **Contextual Linking**: 各パネルやダッシュボードのヘッダーに、以下のリンクを含めます。
  - **Runbook**: 異常時の対応手順。
  - **Slack Channel**: 担当チームとの連絡先。
  - **Repository**: 関連するソースコード。
- **Avoid Overload**: 1つのダッシュボードに情報を詰め込みすぎず、階層構造（Overview -> Service Detail -> Instance Detail）を持たせます。

## 4. 継続的な改善

- **Monthly Reliability Reviews**: 毎月、SLOの達成状況とエラー予算の消費理由を振り返り、目標値の調整や根本対策を議論します。
- **Standardization**: チーム間で共通のダッシュボードテンプレートやタグ付けルールを使用し、他チームの状況を容易に把握できるようにします。
