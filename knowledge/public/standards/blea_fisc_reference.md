# AWS 金融リファレンスアーキテクチャ (BLEA for FSI) 活用ガイド

本ドキュメントは、AWSが提供する「Baseline Environment on AWS for Financial Services Institute (BLEA for FSI)」に基づき、FISC準拠のセキュアなマルチアカウント基盤を構築するための技術リファレンスです。

## 1. コアアーキテクチャ：マルチアカウント・ガバナンス

金融機関に求められる強力な分離と中央統制を実現するため、**AWS Control Tower** を基盤としたマルチアカウント戦略を基本とします。

- **Governance Base (管理アカウント)**: 組織全体の方針（SCP等）を管理。
- **Log Archive Account (ログアーカイブ)**: 全アカウントの操作ログ、通信ログを一元集約し、改ざん防止状態で保存。
- **Security Account (監査)**: Security Hub, GuardDuty による統合的な脅威検知。

## 2. 基盤構築の自動化 (IaC)

- **AWS CDK (Cloud Development Kit)** を活用し、FISC安全対策基準にマッピングされた「ガードレール」をプログラムとして配布・適用。
- 設定のドリフト（乖離）を検知し、自動修復または通知を行う構成（AWS Config）。

## 3. 金融ワークロード別ベストプラクティス

特定の業務要件に応じたサンプルアーキテクチャを選択・適用します。

- **勘定系 (Core System)**: 極めて高い可用性とデータの整合性。
- **オープンAPI (Open API)**: セキュアな外部接続と、FAPI (Financial-grade API) 準拠の認証。
- **顧客チャネル (Customer Channels)**: モバイル・Web向けの D-DoS 対策と WAF の適用。
- **サイバーレジリエンス**: 攻撃を受けた際の自動的なネットワーク隔離と、バックアップからの高速復旧。

## 4. FISC実務基準への対応

各 CDK テンプレートは、FISC実務基準の各項目（例：アクセスコントロール、暗号化、監査ログ）に対して、AWSのどのサービス設定が対応するかを明確化しています。
