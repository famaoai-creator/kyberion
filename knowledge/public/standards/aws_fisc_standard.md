---
title: AWS FISC (金融機関向け安全対策基準) 準拠ガイド
category: Public
tags: [public, standards, aws, fisc, standard, security]
importance: 10
author: Ecosystem Architect
last_updated: 2026-10-05
kind: evergreen
scope: repository
authority: standard
phase: [alignment, execution, review]
role_affinity: [solution_architect, cyber_security, software_developer, ruthless_auditor]
applies_to: [security, compliance, architecture]
owner: cyber_security
status: active
---

# AWS FISC (金融機関向け安全対策基準) 準拠ガイド

本ドキュメントは、AWS上でFISC安全対策基準を遵守するための設計・運用のポイントをまとめたものです。

> **版情報（2026-10-05 確認）**: 最新は **第14版（2026年3月25日公開）**。ただし AWS 公式「金融機関向け AWS FISC 安全対策基準対応リファレンス」は第13版対応版（2025年8月）が現行であり、第14版対応の AWS リファレンスは未発行。SCSK 等のコンソーシアム参考文書（第3版・2026年7月）も第13版ベース。以下は第13版対応を基準としつつ、第14版の差分は §1.5 を参照。

## 1. FISC第13版の主要なアップデート

- **サイバーセキュリティ対策の強化**: 標的型攻撃やサプライチェーン・リスクに対する能動的な監視・防御要件の追加。
- **AI/生成AI利用への対応**: AI特有の機密性・完全性・可用性の定義と、不適切な出力（ハミング、バイアス等）への対策。
- **クラウドネイティブな管理**: 責任共有モデルに基づいた、CSP（AWS）とユーザーの役割分担の再定義。

## 1.5 第14版（2026-03-25 公開）の主要な追加点

FISC 公式刊行物情報に基づく差分（[fisc.or.jp 刊行物ページ](https://www.fisc.or.jp/publication/academic/007219.php)）:

- **AI の安全対策**: 官公庁・各団体の AI/生成AI ガイドライン・レポートを分析し、基準へ反映（第13版の AI 対応を拡充）。
- **サイバーセキュリティ**: 官公庁・各団体の最新ガイドライン・レポートを基準へ反映。
- **耐量子計算機暗号（PQC）**: 金融庁「預金取扱金融機関の耐量子計算機暗号への対応に関する検討会 報告書」（2024年11月）に基づき、PQC 移行の留意点・対応時期を反映 — 暗号スイートの移行計画が長期要件として入る。
- **システム障害事例・各種ガイドラインの反映**: 障害事例分析とガイドライン改訂を基準項目・解説へ反映。

**実務上の注意**: 現時点で項番照合に使える一次資料は第13版の AWS リファレンスのみ。第14版ベースでの項番対応は、AWS リファレンス改訂版の発行後に再検証すること。官公庁の生成AIガイドライン（金融庁 AIDP、AI事業者ガイドライン、AISI評価観点ガイド等）の索引は `japan-gov-genai-guidelines-index.md` を参照。

## 2. AWS Well-Architected FSI Lens (for FISC)

AWSが提供する金融サービス（FSI）向けレンズを活用することで、FISC基準を Well-Architected の5つの柱にマッピングできます。

- **FISCSEC5-BP05**: 多要素認証（MFA）の強力な適用。
- **データ暗号化**: 転送中および保管中のデータの暗号化（AWS KMSの活用）。
- **可用性**: マルチAZ構成による単一障害点（SPOF）の排除。

## 3. 実装のポイント

- **リファレンスの入手**: パートナー企業（NEC, SCSK, NTTデータ等）が公開している「AWS FISC安全対策基準対応リファレンス」を最新の設計書（Excel/PDF）として参照すること。
- **自動スキャンの活用**: `code-actuator` / `secret-actuator` 等の governed review flow を用い、AWS Config や Security Hub と連携して定常的な準拠状況チェックを行う。

## 4. 証跡管理

- **CloudTrail**: API操作ログの全件取得とS3への保存（WORM形式推奨）。
- **GuardDuty**: インテリジェントな脅威検知と即時通知。
