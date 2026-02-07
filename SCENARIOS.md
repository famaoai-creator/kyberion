# Gemini Skills 活用シナリオ集

本リポジトリに実装されたスキル群を組み合わせることで、ソフトウェア開発ライフサイクルの各フェーズを高度に自動化できます。

## 1. 既存資産の可視化とリバースエンジニアリング
仕様書が未整備、あるいはレガシー化したプロジェクトの現状を迅速に把握します。
- **ステップ**:
    1. `codebase-mapper`: プロジェクトのディレクトリ構造を把握。
    2. `schema-inspector`: DB定義やAPI定義を自動抽出。
    3. `terraform-arch-mapper` & `diagram-renderer`: インフラ構成を可視化（Mermaid -> PNG）。
    4. `ppt-artisan`: 抽出情報を整理し、現状分析レポート（PPTX）を自動生成。

## 2. 要件定義からテスト設計までの品質パイプライン
IPA/TIS標準に準拠した高品質なドキュメントとテスト設計をシームレスに生成します。
- **ステップ**:
    1. `requirements-wizard`: IPA標準で要件定義の抜け漏れをレビュー。
    2. `nonfunctional-architect`: インフラコード（IaC）から非機能要求を自動判定。
    3. `test-viewpoint-analyst`: TISカタログに基づき、要件に紐付いたテスト観点を抽出。
    4. `excel-artisan`: 抽出した観点をテストケース管理表（Excel）として出力。

## 3. 自動UI監査とビジュアル・レポート
Webサイトの主要動線を自動確認し、エビデンス付きの報告書を作成します。
- **ステップ**:
    1. `browser-navigator`: Playwrightでサイトを自動巡回し証跡（SS）を撮影。
    2. `doc-to-text`: 撮影したSSをOCR解析し、期待値との整合性を検証。
    3. `ppt-artisan`: 証跡画像とテスト結果を統合したプレゼン資料を作成。

## 4. プリコミット・セキュリティ・ヘルスチェック
コードをコミットする前に、多角的な品質・安全性の監査を自動実行します。
- **ステップ**:
    1. `local-reviewer`: Git差分（Staged）をAIがコードレビュー。
    2. `security-scanner`: Trivy等を用いて脆弱性とシークレット漏洩をスキャン。
    3. `project-health-check`: CI/CD、テスト、Lintの設定状況からプロジェクトの健全性を採点。
    4. `log-analyst`: 直近のビルド/実行ログからエラーの兆候を特定。
