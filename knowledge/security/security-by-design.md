---
title: Security By Design Standard
category: Security
tags: [security, design]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Security By Design Standard

このドキュメントは、システム開発の初期段階からセキュリティを組み込み、後戻りコストを最小化しつつ堅牢性を最大化するための、設計原則とノウハウをまとめたものである。

## 1. コア設計原則 (Core Principles)

- **Shift Left**: セキュリティを開発の最終段階（テストフェーズ）ではなく、要件定義・設計段階から組み込む。
- **Defense in Depth (多層防御)**: 一つの防御策（例：ファイアウォール）が突破されても、別の層（例：認証、暗号化）で守る設計。
- **Least Privilege (最小権限の原則)**: プロセスやユーザーには、業務遂行に必要な最小限の権限のみを付与する。
- **Fail Securely (セキュアな失敗)**: システムがエラーで停止する際、権限を開放したりセキュリティを無効化したりせず、最も安全な状態（拒否状態）で停止する。
- **Default Deny (デフォルト拒否)**: 明示的に許可されていないものは、全て拒否する。

## 2. 脅威モデリング (Threat Modeling) - STRIDE

設計段階で「どのような攻撃が可能か」を構造的に分析する。

| 脅威タイプ | 内容 | 設計上の対策 |
| :--- | :--- | :--- |
| **S**poofing (なりすまし) | 他のユーザーやシステムを装う。 | 強固な認証、署名、MFA。 |
| **T**ampering (改ざん) | データを不正に書き換える。 | 完全性チェック (Hash)、デジタル署名。 |
| **R**epudiation (否認) | 操作を行った事実を否定する。 | 変更不可なログ、タイムスタンプ、証跡管理。 |
| **I**nformation Disclosure | 機密情報の漏洩。 | 暗号化 (At Rest/In Transit)、最小出力。 |
| **D**enial of Service | システムの停止・過負荷。 | レート制限、冗長化、リソース分離。 |
| **E**levation of Privilege | 権限昇格。 | 権限分離、アクセスコントロールリスト (ACL)。 |

## 3. 安全な設計パターン (Secure Design Patterns)

### 認証・認可
- **Centralized Gatekeeper**: 各サービスで個別に認証せず、API Gateway 等で一括して検証する。
- **Token-based Stateless Auth**: セッション維持ではなく、JWT 等の署名付きトークンを使用し、有効期限を短く設定する。

### データ保護
- **Encryption By Default**: 全ての通信を TLS 1.3+ で保護し、DB 内の機密フィールドはアプリケーション層で暗号化する。
- **Data Minimization**: 収集するデータは必要最小限に抑え、保持期限を設計に組み込む。

### インフラ・ネットワーク
- **Micro-segmentation**: ネットワークを細分化し、侵害が発生した際の影響範囲を限定（爆発半径の抑制）する。
- **Zero Trust Architecture**: 内外を問わず、全てのアクセスを検証対象とする。

## 4. 運用と統治 (Alignment)

- **ADR (Architecture Decision Records)**: セキュリティに関する重要な設計判断を ADR として記録し、文脈（Context）を保存する。
- **Compliance Alignment**: IPA 非機能要求、FISC 安全対策基準、OWASP ASVS 等の外部基準とのマッピング。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
