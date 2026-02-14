# 分散システム ＆ アーキテクチャパターン

## 1. 分散トランザクション

- **Saga Pattern**: 複数のサービスにまたがるトランザクションを、補償トランザクション（Compensating Transactions）の連鎖で管理する。
- **2PC (Two-Phase Commit)**: 厳密な一貫性を保つが、可用性とスケーラビリティに制約がある。
- **Eventual Consistency**: 最終的な一貫性を許容し、スケーラビリティを優先する。

## 2. マイクロサービス・パターン

- **CQRS (Command Query Responsibility Segregation)**: 読み取りと書き込みのモデルを分離し、パフォーマンスを最適化する。
- **Event Sourcing**: 状態の「結果」ではなく「変更履歴（イベント）」を保存する。
- **API Gateway**: 複雑なバックエンドサービスへの入り口を一元化し、認証やルーティングを行う。

## 3. レジリエンス・パターン

- **Circuit Breaker**: 障害の連鎖を防ぐために、失敗し続けているサービスへのリクエストを遮断する。
- **Bulkhead**: リソースを分離し、一部の障害がシステム全体に波及しないようにする。
- **Retry with Exponential Backoff**: ネットワークエラー等に対し、間隔を広げながら再試行する。
