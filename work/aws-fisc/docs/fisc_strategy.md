# AWS FISC 準拠に向けたプロジェクト戦略

## 1. 現状分析とギャップ・アセスメント
- `project-health-check` および `security-scanner` を実行し、現状の AWS 構成が FISC 13版の推奨事項（MFA、暗号化、リージョン制限等）を満たしているか確認する。

## 2. 統制設計 (Design)
- `environment-provisioner` を使い、FISC準拠のリファレンスアーキテクチャ（マルチAZ、セキュアなVPC設計）を Terraform で自動生成する。
- `compliance-officer` スキルを活用し、AWS Config ールと FISC 基準のマッピング表を作成する。

## 3. 継続的コンプライアンス (Continuous Compliance)
- `supply-chain-sentinel` により、金融システムで使用するライブラリの透明性を確保し、SBoM を管理する。
- `disaster-recovery-planner` により、FISCが求める RTO/RPO に基づいた復旧手順書を自動生成する。

---
**参考URL**: [AWS Blog - FISC第13版アップデート](https://aws.amazon.com/jp/blogs/news/fiscreference-and-lens-fisc13-update/)
