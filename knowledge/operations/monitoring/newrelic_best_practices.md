# New Relic 導入・運用ベストプラクティス

## 1. Full-Stack Observability

- **APM**: 全てのバックエンドサービスにAgentを導入。`Apdex` スコアの閾値（T値）をサービスごとの実測値に合わせてチューニングする。
- **Browser**: フロントエンドのパフォーマンス（LCP, CLS）を計測するため、SPA対応の設定を有効化する。

## 2. ゴールデンシグナル監視 (Golden Signals)

以下の4指標をダッシュボードの最上部に配置する。

1. **Latency**: 応答時間（p95, p99）。
2. **Traffic**: リクエスト数/スループット。
3. **Errors**: エラー率。
4. **Saturation**: リソース飽和度（CPU/DBコネクション）。

## 3. コスト管理 (Data Ingestion)

- **Drop Rules**: 不要なログやメトリクスをIngest前に破棄するルールを設定。
- **Retention**: データ種別ごとに保持期間を最適化（例：詳細トレースは7日、メトリクスは13ヶ月）。
