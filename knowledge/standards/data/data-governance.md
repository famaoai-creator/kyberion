---
title: Data Engineering & Governance Standards
category: Standards
tags: [standards, data, governance]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Data Engineering & Governance Standards

このドキュメントは、データの品質、一貫性、および信頼性を保証するための、データエンジニアリングの標準規約である。

## 1. データ品質 (Data Quality) の 6 次元

1.  **Accuracy (正確性)**: データが事実を正しく反映しているか。
2.  **Completeness (網羅性)**: 必要な項目が欠落していないか。
3.  **Consistency (一貫性)**: 複数のシステム間で矛盾がないか。
4.  **Timeliness (鮮度)**: 必要なタイミングで利用可能か。
5.  **Validity (有効性)**: 定義されたフォーマットやルールに準拠しているか。
6.  **Uniqueness (一意性)**: 重複したレコードが存在しないか。

## 2. データ・リネージ (Data Lineage)

データがどこから来て、どのように加工され、どこへ行くのかという「家系図」を記録・追跡する。
- **目的**: 障害発生時の影響範囲の特定、およびデータの信頼性証明。

## 3. ETL/ELT パイプラインの設計

- **Idempotency (冪等性)**: 同じジョブを何度実行しても、結果が同じになるように設計する。
- **Observability**: ジョブの成功・失敗、処理件数、実行時間を監視する。
- **Schema Evolution**: スキーマ変更時、既存のデータや後続のプロセスを壊さないための制御。

## 4. データ・カタログ (Data Catalog)

データの所在、定義、所有者、機密レベルをメタデータとして集中管理し、データ活用を民主化する。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
