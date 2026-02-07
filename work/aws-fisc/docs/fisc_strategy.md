# AWS FISC 準拠に向けたプロジェクト戦略

## 1. 現状分析とギャップ・アセスメント
- `project-health-check` および `security-scanner` を実行し、現状の AWS 構成が FISC 13版の推奨事項（MFA、暗号化、リージョン制限等）を満たしているか確認する。

## 2. 統制設計 (Design)
- **Landing Zone の構築**: AWS Control Tower を用い、ログアーカイブ・セキュリティ監査・ワークロードの各アカウントを分離したマルチアカウント基盤を構築する。
- **BLEA for FSI の適用**: `aws-samples` のリファレンスアーキテクチャに基づき、CDK を用いて FISC 準拠のガードレールを自動展開する。
- `environment-provisioner` を使い、業務特性（勘定系、API系、モバイル等）に合わせたセキュアな VPC およびリソースを Terraform/CDK で定義する。

## 3. 継続的コンプライアンス (Continuous Compliance)
- `supply-chain-sentinel` により、金融システムで使用するライブラリの透明性を確保し、SBoM を管理する。
- `disaster-recovery-planner` により、FISCが求める RTO/RPO に基づいた復旧手順書を自動生成する。

---
**参考URL**: [AWS Blog - FISC第13版アップデート](https://aws.amazon.com/jp/blogs/news/fiscreference-and-lens-fisc13-update/)
