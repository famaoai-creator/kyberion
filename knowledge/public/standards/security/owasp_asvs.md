---
title: OWASP ASVS 5.0 (Application Security Verification Standard)
category: Standards
tags: [standards, security, owasp, asvs, verification, appsec, audit]
importance: 10
author: Ecosystem Architect
last_updated: 2026-10-12
kind: evergreen
scope: repository
authority: standard
phase: [alignment, execution, review]
role_affinity: [cyber_security, security_engineer, solution_architect, qa_lead, ruthless_auditor]
applies_to: [web-applications, api, security-audit, acceptance-criteria]
owner: cyber_security
status: active
---

# OWASP ASVS 5.0 (Application Security Verification Standard)

Webアプリケーション/サービスのセキュリティ**検証標準**（v5.0.0、2025-05-30 リリース）。Top 10 が「リスクの優先順位付け」であるのに対し、ASVS は pass/fail 判定可能な**要求（requirement）の集合** — セキュリティ監査・受入基準・点検パイプラインの検査項目ソースとして使う。

## 使い方の原則

- 要求は「何を達成すべきか」だけを規定し、実装手段は規定しない（実装は Cheat Sheet Series、検証手法は Web Security Testing Guide が担う）。
- **Documented security decisions**: 各章先頭の「文書化要求」は、組織が採ったセキュリティ上の決定（許可ファイル形式、セッションタイムアウト方針等）を文書化させ、その後の実装要求がその文書と照合される二段構え。Kyberion の外部サービス台帳・脅威モデル文書と対応づける。
- ASVS は製品内の統制のみを対象とし、CI/CD・ホスティング・運用は別の基準で補完する（運用側は本リポジトリのランサムウェア/インシデント手順、IPA チェックリストでカバー）。

## 検証レベル（優先度ベース）

| Level | 含まれる要求       | 位置づけ                         | 適用目安                                            |
| ----- | ------------------ | -------------------------------- | --------------------------------------------------- |
| L1    | 全体の ~20%        | 第一防御層・最重要最低限         | 全公開アプリの必修ライン。IPA緊急点検の平時化に相当 |
| L2    | +~50%（累計 ~70%） | ほぼ全てのアプリが目指すべき水準 | 個人情報・機微情報を扱うサービスの標準目標          |
| L3    | 残り ~30%          | 最高水準・多層防御               | 金融・基幹系・高価値情報資産                        |

## 章構成（V1–V17）

| 章                                      | 対象                                       | 自律点検での主な用途                             |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| V1 Encoding and Sanitization            | 出力エンコーディング、インジェクション防御 | 静的監査の仮説カテゴリ                           |
| V2 Validation and Business Logic        | 入力検証、業務ルール強制                   | 設計文書との照合                                 |
| V3 Web Frontend Security                | セキュリティヘッダ、CSP、ブラウザ側防御    | `network:fetch` ヘッダ点検項目                   |
| V4 API and Web Service                  | API 認可、レート制限、スキーマ検証         | API エンドポイント点検項目                       |
| V5 File Handling                        | アップロード/ダウンロード統制              | ファイル機能を持つアプリの点検                   |
| V6 Authentication                       | パスワード方針、MFA、認証強度              | `account-audit` の MFA/パスワード判定基準        |
| V7 Session Management                   | セッション生成・失効・タイムアウト         | 認証セッション設定レビュー                       |
| V8 Authorization                        | アクセス制御モデル、権限付与               | 権限棚卸・構成要素単位の権限見直し               |
| V9 Self-contained Tokens                | JWT 等トークン検証                         | トークン利用サービスの設定点検                   |
| V10 OAuth and OIDC                      | 連携フロー、クライアント設定               | API連携・SSO 連携の構成レビュー                  |
| V11 Cryptography                        | 暗号アルゴリズム・鍵管理                   | 暗号化要件の判定基準（PQC 含む FISC 観点と併用） |
| V12 Secure Communication                | TLS 設定、証明書                           | `exposure-check` の TLS/証明書点検項目           |
| V13 Configuration                       | ビルド・デプロイ・シークレット管理         | 構成管理・シークレットローテーション監査         |
| V14 Data Protection                     | データ分類、保存・伝送時保護               | 保有データ再点検・暗号化判定基準                 |
| V15 Secure Coding and Architecture      | セキュア設計、依存管理                     | アーキテクチャレビュー・サプライチェーン観点     |
| V16 Security Logging and Error Handling | 監査ログ、異常処理                         | ログ取得内容/保持期間・fail-closed 判定基準      |
| V17 WebRTC                              | リアルタイム通信（該当アプリのみ）         | 対象外が多い、該当時のみ適用                     |

## Kyberion への適用

- **外部サービス点検パイプラインの検査項目ソース**: 台帳の各サービスに対し、L1 相当のリモート検査可能項目（V3 ヘッダ、V12 TLS、V6 MFA 状態、V16 ログ方針の確認）を機械点検し、残りを人間レビュー項目として報告する二層構造にする。
- **静的セキュリティ監査の基準**: `knowledge/product/pipeline-templates/security-audit-static-analysis.json` の `reference_standards` として "OWASP ASVS 5.0" を指定し、章番号で coverage ledger を引く。
- **受入基準**: 新規外部公開アプリの要件では、目標レベル（原則 L2、機微情報は L3）を nonfunctional requirement として宣言する。

---

_Reference: [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release) / [asvs.dev](https://asvs.dev/). リスク一覧は `owasp_web_top10.md`、緊急点検手順は `../ipa/unauthorized-access-checklist.md`、インシデント対応は `../../procedures/system/security-incident-response.md` を参照。_
