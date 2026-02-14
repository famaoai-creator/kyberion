# Gemini Skills Knowledge Base: Rights & Usage

本ディレクトリ（`knowledge/`）に含まれる情報の取り扱いについて。

## 1. ライセンス (Original Content)

famaoai によって独自に構築・構造化されたナレッジ、プロンプト、およびガイドラインは、プロジェクトルートの **MIT License** に準拠します。

## 2. 外部出典（External References）

以下のディレクトリに含まれる情報の「事実」「引用基準」「規格名」等は、それぞれの権利者に基づきます。

- **`fisc-compliance/`**: 公益財団法人 金融情報システムセンター (FISC) の基準を参照。
- **`sdlc/`**: 独立行政法人 情報処理推進機構 (IPA) 等の業界標準を参照。
- **`tech-stack/`**: 各ソフトウェアベンダー（AWS, Google, Box, Atlassian等）の公式仕様を参照。

これらの外部情報は、エンジニアリングの自動化および品質向上のための「リファレンス」として利用されており、情報の正確性や最新性については各公式サイトを確認してください。

## 3. Knowledge Modules

### Security

- **`security/scan-patterns.yaml`**: Secret detection patterns and dangerous code pattern definitions for the security-scanner skill.
- **`security/security-best-practices.md`**: OWASP Top 10 overview, secure coding patterns for Node.js/JavaScript, common vulnerability detection, security scanning tools, and input validation guidelines.

### DevOps

- **`devops/ci-cd-patterns.md`**: CI/CD pipeline design patterns, GitHub Actions best practices, testing strategies, deployment strategies (blue-green, canary, rolling), and monitoring/alerting in CI/CD.

### Architecture

- **`architecture/microservices-patterns.md`**: Microservices design patterns (saga, circuit breaker, API gateway, strangler fig), service communication patterns, data management (CQRS, event sourcing), service discovery, load balancing, and observability patterns.
