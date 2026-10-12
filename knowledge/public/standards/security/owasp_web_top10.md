---
title: OWASP Top 10:2025 (Web Application)
category: Standards
tags: [standards, security, owasp, web, top10, appsec, vulnerability]
importance: 10
author: Ecosystem Architect
last_updated: 2026-10-12
kind: evergreen
scope: repository
authority: standard
phase: [alignment, execution, review]
role_affinity: [cyber_security, security_engineer, solution_architect, software_developer, qa_lead]
applies_to: [web-applications, api, external-services, security-audit]
owner: cyber_security
status: active
---

# OWASP Top 10:2025 (Web Application)

Webアプリケーションの主要リスク10項目（2025-11-06 リリース、2021年版以来の全面改訂）。外部公開アプリの点検・セキュリティ監査・レビュー観点の共通言語として使用する。LLM/エージェント固有のリスクは `owasp_llm_top10.md` を参照。

## 2021 → 2025 の主な変更点

- **Security Misconfiguration** が #5 → #2 に上昇（設定起因の侵害の増大）。
- **Vulnerable and Outdated Components** が廃止され、より広い **Software Supply Chain Failures** (#3) に再編。
- **A10 Mishandling of Exceptional Conditions** が新設（fail-open、不適切なエラー処理、異常条件の誤処理）。
- **A09** が "Logging and Monitoring" → "Logging & Alerting" に改名 — ログを取るだけでなく**アラートして行動を起こせること**が要件化された。

## A01:2025 — Broken Access Control

- **概要**: 認可チェックの欠落・回避。IDOR、強制ブラウジング、権限昇格、CORS 不備等。
- **Kyberion運用チェック**: API連携アプリの構成要素単位の権限付与見直し（IPA点検と対応）。監査時は `ViewerContext` 同等の server-side 認可解決が全ルートで行われているかを確認 — client 指定の `tenant`/`tier` パラメータを認可として扱っていないか（AGENTS.md §1 HTTP visibility scope と同型の欠陥）。

## A02:2025 — Security Misconfiguration

- **概要**: 不要機能の有効化、デフォルト認証情報、冗長なエラー出力、セキュリティヘッダ欠落、クラウド設定不備。
- **Kyberion運用チェック**: `exposure-check` 型パイプラインで `network:fetch` によるレスポンスヘッダ点検（`Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`、サーバ/バージョン露出）が直接検出可能。台帳登録済みエンドポイントへの定期適用を想定。

## A03:2025 — Software Supply Chain Failures

- **概要**: 依存パッケージ・ビルド基盤・配布経路の侵害。悪意ある依存、CI 改ざん、署名不備。
- **Kyberion運用チェック**: `pipelines/dependency-vuln-scan.json`（日次、ledger append）が既に基盤として存在。pnpm の `minimumReleaseAge` 運用と合わせ、依存の新規導入は公開から7日超を原則とするポリシーを監査観点に含める。

## A04:2025 — Cryptographic Failures

- **概要**: 弱い暗号・鍵管理不備・平文伝送によるデータ露出（旧 Sensitive Data Exposure）。
- **Kyberion運用チェック**: TLS 1.2+ 強制、証明書期限監視、平文 HTTP→HTTPS リダイレクト確認はリモート点検可能項目。保有データ暗号化の是非は IPA データ再点検と連動。

## A05:2025 — Injection

- **概要**: SQL/NoSQL/OS コマンド/LDAP 等への信頼境界越えインジェクション、XSS を含む。
- **Kyberion運用チェック**: 自律運用では検査よりも**設計・レビュー側**の観点。`security-audit-static-analysis` テンプレート（Semgrep + 脅威モデル先行）の仮説生成基準としてカテゴリを参照させる。

## A06:2025 — Insecure Design

- **概要**: 実装の欠陥ではなく設計段階の脅威モデリング・セキュア設計の欠落。
- **Kyberion運用チェック**: ミッションの alignment フェーズで脅威モデル作成を必須化する型が `security-vulnerability-scan` テンプレートに既存（`threat_model_approved` ゲート）。設計レビュー時の参照基準。

## A07:2025 — Authentication Failures

- **概要**: 弱いパスワード方針、クレデンシャルスタッフィング耐性欠如、セッション管理不備、MFA 未強制。
- **Kyberion運用チェック**: 外部サービスのアカウント棚卸・MFA 未設定アカウント検出（`account-audit` 型パイプライン）の検出基準。`browser-actuator` の passkey 系 ops は認証強度の観察に使用可能。

## A08:2025 — Software or Data Integrity Failures

- **概要**: コード・データ成果物の完全性検証欠落（未検証の更新、CI/CD 信頼境界違反、オブジェクトデシリアライズ等）。
- **Kyberion運用チェック**: Kyberion 自身の `audit-verify-daily`（監査チェーン整合性検証）が同型の統制。外部サービスでは署名付き更新・SRI・成果物ハッシュ照合の有無を点検項目化。

## A09:2025 — Security Logging & Alerting Failures

- **概要**: 監査ログの欠落・不十分な保持、異常検知とエスカレーション経路の欠如。2025年版では「アラート」が明示要件。
- **Kyberion運用チェック**: IPA点検の「ログ異常確認」項目と直結。ログ取得内容・保持期間の見直し、ops-alert 型エスカレーションの有無を台帳の必須属性として管理する。

## A10:2025 — Mishandling of Exceptional Conditions

- **概要**: エラー・異常系処理の不備 — fail-open、例外で内部情報露出、リソース枯渇、想定外入力での未定義動作。
- **Kyberion運用チェック**: レビュー観点として「失敗時に deny に倒れるか（fail-closed）」を全ガードレールに問う。Kyberion 自身の facet 解決・ADF 検証が fail-closed であるのと同じ基準を対象アプリに適用。

---

_Reference: [OWASP Top 10:2025](https://owasp.org/Top10/2025/) (final release, 2025-11-06). 検証要件への展開は `owasp_asvs.md`、緊急点検への適用は `../ipa/unauthorized-access-checklist.md` を参照。_
