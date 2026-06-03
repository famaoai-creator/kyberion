---
title: Monitoring & Observability Best Practices
category: Operations
tags: [operations, monitoring, best, practices]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Monitoring & Observability Best Practices

システムの状態を正確に把握し、迅速な問題解決と安定したサービス提供を実現するための監視・オブザーバビリティの指針です。

## 1. 共通の原則 (Core Principles)

- **Three Pillars**: メトリクス (Metrics)、ログ (Logs)、トレース (Traces) を組み合わせ、多角的に分析します。
- **Golden Signals**: 以下の4つの指標を最優先で監視します。
  - **Latency**: リクエストの処理時間。
  - **Traffic**: システムへの需要（リクエスト数）。
  - **Errors**: リクエストの失敗率。
  - **Saturation**: リソース（CPU, メモリ, ディスク等）の利用率。
- **Tagging & Metadata**: すべてのデータに適切なタグ（env, service, region, teamなど）を付与し、動的なフィルタリングと相関分析を可能にします。

## 2. New Relic ベストプラクティス

New Relicはアプリケーション（APM）に強みを持ちます。

- **Deep APM Insight**: コードレベルのボトルネック（スロークエリ、外部API呼出の遅延）を特定します。
- **NRQL Optimization**: NRQL (New Relic Query Language) を使用して、ビジネスKPIとシステムメトリクスを組み合わせたカスタムダッシュボードを作成します。
- **Error Profiles**: エラーグループ化機能を活用し、特定のリビジョンや環境で発生している特有のエラーを迅速に特定します。
- **User Experience**: Browser/Mobile 監視を組み合わせ、エンドユーザーから見た実際のパフォーマンス（LCP, FIDなど）を監視します。

## 3. Datadog ベストプラクティス

Datadogはインフラとデータの相関分析に強みを持ちます。

- **Unified Observability**: インフラメトリクス、APM、ログを1つのダッシュボードに統合し、横断的にトラブルシュートします。
- **Anomaly Detection**: 機械学習ベースの異常検知（Anomaly Detection）や予測（Forecasting）を活用し、静的な閾値では捉えられない予兆を検知します。
- **Service Map**: 自動生成されるサービスマップを活用し、複雑なマイクロサービス間の依存関係とボトルネックを可視化します。
- **Log Management**: インデックス化するログを最適化し、コストを抑えつつ必要な時にトレースと紐づいたログを参照できるようにします。

## 4. アラート設計 (Alerting Strategy)

- **Actionable Alerts**: 担当者が即座にアクションを取れるアラートのみを作成します。
- **Multi-Alert Strategy**:
  - **Warning**: Slack/Teams等のチャットへ通知。
  - **Critical**: PagerDuty等のオンコールツールへ発報。
- **Context Attachment**: アラートには、原因調査に役立つダッシュボードやRunbookのリンクを必ず含めます。
