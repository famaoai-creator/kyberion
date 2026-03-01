# resilience/
SRE 監修：カオス・エンジニアリングと自律復旧

## 1. Industry Best Practices
- **Chaos Engineering Principles**: 本番環境の定常状態を定義し、カオス変数を導入して仮説を検証する (Netflix).
- **Circuit Breaker Pattern**: 外部 API の連続失敗を検知し、即座にフォールバックへ切り替えることで二次被害を防ぐ.
- **Fail-Fast & Graceful Degradation**: 致命的なエラー時は即座に停止し、部分的に機能提供を継続する設計 (AWS Well-Architected).

## 2. Autonomous Recovery
- **Exponential Backoff**: API レート制限時は、再試行間隔を指数関数的に増やし、輻輳を回避する.
- **State Reconciliation**: AI エージェントの内部状態と物理的なファイル状態を定期的に同期し、不整合を自動修復する.
