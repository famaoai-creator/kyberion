# クラウドネイティブ ＆ インフラ設計

## 1. 12-Factor App (現代的クラウドアプリケーションの指針)

- **Codebase**: 1つのリポジトリ、多デプロイ。
- **Config**: 設定を環境変数に格納。
- **Backing Services**: データベース等をアタッチ可能なリソースとして扱う。
- **Processes**: ステートレスなプロセスとして実行。
- **Port Binding**: サービスをポートにバインドして公開。
- **Concurrency**: プロセスモデルによるスケーリング。
- **Disposability**: 高速な起動とグレースフルなシャットダウン。

## 2. コンテナ & オーケストレーション (Kubernetes)

- **Sidecar Pattern**: メインコンテナの機能を拡張（ログ収集、プロキシ等）。
- **Operator Pattern**: 運用の知見をコード化し、複雑なステートフルアプリケーションを自律管理。
- **Service Mesh (Istio等)**: サービス間の通信（可観測性、セキュリティ、耐障害性）を制御。

## 3. IaC (Infrastructure as Code)

- **Immutability**: 既存のインフラを変更せず、常に新しいバージョンをデプロイする（Blue/Greenデプロイメント）。
- **Declarative Configuration**: 「あるべき状態」を記述し、ツール（Terraform等）が差分を埋める。
