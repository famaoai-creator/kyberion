# DevSecOps Pipeline Standards: Automating Trust

このドキュメントは、DevOps にセキュリティを統合し、安全なリリースを自動化するためのパイプライン標準規約である。

## 1. パイプラインの 5 つのフェーズ

### 1. Build & Lint (構築と静的解析)
- ソースコードのビルド。
- コーディング規約 (Lint) と型チェック (Type Check)。
- **自動化**: ESLint, Prettier, tsc。

### 2. Secure (セキュリティスキャン)
- 依存関係の脆弱性スキャン (SCA)。
- 静的アプリケーションセキュリティテスト (SAST)。
- シークレットスキャン。
- **自動化**: npm audit, Semgrep, Gitleaks。

### 3. Test (自動テスト)
- 単体テスト (Unit Test)。
- 統合テスト (Integration Test)。
- API / 契約テスト (Contract Testing)。
- **自動化**: Vitest, Playwright, Maestro。

### 4. Audit & Compliance (監査とガバナンス)
- ライセンス・コンプライアンスの確認。
- SBOM (Software Bill of Materials) の生成。
- インフラ構成の監査 (IaC Scan)。
- **自動化**: CycloneDX, Checkov。

### 5. Deploy & Verify (デプロイと検証)
- ステージング/本番環境へのデプロイ。
- デプロイ後のスモークテスト。
- 可観測性 (Monitoring) の確立。

## 2. 品質ゲート (Quality Gates)

パイプラインの各段階で、次へ進むための基準（ゲート）を定義する。

- **Critical Vulnerabilities**: 0件（検知されたらビルド失敗）。
- **Unit Test Pass Rate**: 100%。
- **Lint Errors**: 0件。

## 3. IaC (Infrastructure as Code) の重要性

インフラ構成をコード化し、アプリケーションと同様にレビューと自動テストの対象とする。
- 環境の一貫性確保。
- 変更履歴の追跡可能性。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
