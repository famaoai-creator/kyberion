# Kyberion Knowledge Base: Rights & Usage

## Retrieval and integrity files

`knowledge/_index.md` (tracked navigation index) and `knowledge/_integrity-manifest.json` (gitignored local size inventory, rebuilt by `pnpm build`) are generated artifacts. They are not the retrieval contract. Task delivery resolves the scoped corpus through [`product/governance/knowledge-slices.json`](product/governance/knowledge-slices.json), validated by [`product/schemas/knowledge-slices.schema.json`](product/schemas/knowledge-slices.schema.json) and consumed by `libs/core/knowledge/knowledge-slices.ts`.

The legacy content-first documents that intentionally do not carry task-card frontmatter are listed in [`product/governance/frontmatter-exclusions.json`](product/governance/frontmatter-exclusions.json). New scoped knowledge cards must carry frontmatter; the exclusion manifest is reviewed with the knowledge taxonomy rather than inferred from missing metadata.

本ディレクトリ（`knowledge/`）に含まれる情報の取り扱いについて。

## 1. ライセンス (Original Content)

famaoai によって独自に構築・構造化されたナレッジ、プロンプト、およびガイドラインは、プロジェクトルートの **MIT License** に準拠します。

## 2. 外部出典（External References）

以下のディレクトリに含まれる情報の「事実」「引用基準」「規格名」等は、それぞれの権利者に基づきます。

- **`public/standards/`**: 公益財団法人 金融情報システムセンター (FISC) の基準を参照（`aws_fisc_standard.md`、`blea_fisc_reference.md` 等）。
- **`public/standards/sdlc/`**: 独立行政法人 情報処理推進機構 (IPA) 等の業界標準を参照。
- **`public/tech-stack/`**: 各ソフトウェアベンダー（AWS, Google, Box, Atlassian等）の公式仕様を参照。

これらの外部情報は、エンジニアリングの自動化および品質向上のための「リファレンス」として利用されており、情報の正確性や最新性については各公式サイトを確認してください。

## 3. Knowledge Modules

### Security

- **`product/capability-assets/security-scanner/`**: Secret / vulnerability detection pattern definitions (`vulnerability-patterns.json`, `compliance-mapping.json`) for the security-scanner capability.
- **`public/standards/security/`**: OWASP LLM Top 10 等のセキュリティ標準リファレンス。

### Operations / DevOps

- **`product/operations/`**: SRE・運用の定石（`runbook_best_practices.md`、`modern_sre_best_practices.md`、`incident-management-excellence.md` 等）。

### Architecture

- **`product/architecture/microservices-patterns.md`**: Microservices design patterns (saga, circuit breaker, API gateway, strangler fig), service communication patterns, data management (CQRS, event sourcing), service discovery, load balancing, and observability patterns.
