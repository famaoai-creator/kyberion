# Datadog 導入・運用ベストプラクティス

## 1. 導入の基本 (Setup)

- **Agent**: 全ホスト/コンテナに導入。`DD_TAGS` で `env`, `service`, `version` を統一的に付与すること（Unified Service Tagging）。
- **Integrations**: AWS/GCP連携は必須。CloudWatch Metric Stream を使用し、APIポーリングの遅延とコストを回避する。

## 2. 必須監視設定 (Monitors)

- **APM**: トレース保存率はデフォルト 100% だが、コスト削減のため `Retention Filters` でエラーと高レイテンシのみを長期保存する。
- **Logs**: 全ログを取り込む（Ingest）が、検索用インデックス（Index）には必要なログだけを通す「Logging without Limits」構成にする。

## 3. アラート戦略

- **Multi-Alert**: 警告（Warn）と緊急（Alert）を分け、WarnはSlack通知のみ、AlertはPagerDutyへ発報する。
- **Anomaly Detection**: 閾値固定ではなく、機械学習による異常検知（Anomaly Monitor）をCPUやメモリに使用する。
