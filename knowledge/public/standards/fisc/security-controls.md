---
title: FISC-Aligned Security Standard (Cloud Infrastructure)
category: Standards
tags: [standards, fisc, security, controls]
importance: 10
author: Ecosystem Architect
last_updated: 2026-10-05
---

# FISC-Aligned Security Standard (Cloud Infrastructure)

## 1. Overview

金融情報システムセンター（FISC）の「金融機関等コンピュータシステムの安全対策基準」に基づき、本エコシステムにおけるクラウド・セキュリティの遵守事項を定義する。

## 2. Infrastructure Security (基盤セキュリティ)

- **Isolation (隔離)**: 本番環境、開発環境、テスト環境は、ネットワーク・アカウントレベルで完全に論理隔離されなければならない。（FISC 実務基準 実76 — アカウント単位のワークロード分離、Amazon VPC による論理的分離）
- **Encryption at Rest (不揮発データの暗号化)**: RDS, S3 等の永続ストレージ上のデータは、AWS KMS 等の管理鍵を用いて暗号化されること。（FISC 実務基準 実3・枝番8 — S3/EBS/EC2等の暗号化メカニズムおよびKMSの活用）
- **Encryption in Transit (通信の暗号化)**: 外部通信および内部サービス間通信は TLS 1.2 以上を使用し、平文の通信を許可しないこと。

## 3. Access Control & Identity (アクセス管理)

- **Principle of Least Privilege (最小権限の原則)**: IAM ユーザー/ロールには、業務遂行に必要な最小限の権限のみを付与する。
- **MFA (多要素認証)**: 全ての管理者アクセスおよび特権操作において MFA を強制すること。
- **Credential Rotation (鍵の更新)**: IAM アクセスキー等の長期的な秘密情報は、90日以内にローテーションすること。

## 4. Log Management & Monitoring (証跡管理)

- **Audit Logging**: 操作ログ（CloudTrail）およびアクセスログ（S3/VPC Flow Logs）を常時取得し、改ざん不能なストレージ（S3 Object Lock 等）に保管すること。（FISC 実務基準 実16 — 監査可能イベントの記録、および実務基準補足情報の S3 Object Lock によるログ改ざん防止）
- **Real-time Alerting**: セキュリティ侵害の兆候を検知した場合、直ちに管理者へ通知される仕組みを構築すること。

## 5. Data Sovereignty (主権保護)

- **Data Residency**: 法的な要件に基づき、データの保管場所（リージョン）を制御し、不必要な国外転送を防止すること。

---

_Reference: Synthesized from FISC Security Standards (安全対策基準・実務基準), 第13版._

_Note: 第13版の主な追加点はサイバーセキュリティ対策の強化（標的型攻撃・サプライチェーンリスクへの能動的監視）、AI/生成AI利用への対応、およびクラウド責任共有モデルの再定義とされる（`../aws_fisc_standard.md` 参照）。統制番号は AWS公式「金融機関向け AWS FISC安全対策基準対応リファレンス」（2025年8月・第13版 2025年3月版対応）の項番で照合済み（2026-10-05）。旧引用形式（実務 3-1-1 / 設備 2-2-4 / 実務 4-2-1）は解説書の章節番号であり、AWSリファレンスの項番体系（実N・設N・監N・統N-N）とは一致しなかったため実項番へ付け替えた — 暗号化は設備基準ではなく実務基準の統制項目である点も訂正済み。解説書の章節番号との対応表は AWSリファレンスには非掲載のため、解説書原文での対応確認は別途必要。_
