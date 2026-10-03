---
title: ロール別教育ロードマップ (Learning Paths by Role)
category: Onboarding
tags: [onboarding, learning, paths, security]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# ロール別教育ロードマップ (Learning Paths by Role)

Kyberion エコシステムへ参加するメンバーが、それぞれの役割において専門性を発揮するための学習パス。

## 1. Ecosystem Architect (エコシステム・アーキテクト)

**目標**: モノレポ全体の構造を理解し、新規スキルの設計、共通基盤の改善、およびスケーラビリティの確保ができるようになる。

- **Step 1: 基礎理解**
  - `AGENTS.md` の熟読（動作原理とガバナンス）
  - `libs/core/foundation/`（`@agent/core`）のコードリーディング（標準ユーティリティ）
- **Step 2: Capability Development**
  - `pnpm capabilities` と `knowledge/product/governance/capability-bundles/` を用いた新規 capability のプロトタイピング
  - procedure / knowledge card の標準フォーマット習得
- **Step 3: 高度な管理**
  - `pnpm generate:knowledge-index` による `knowledge/_integrity-manifest.json` の再生成・整合性維持
  - 依存関係グラフ (`dependency-graph.mmd`、`pnpm deps:check`) の分析

## 2. Reliability Engineer (SRE / 信頼性エンジニア)

**目標**: capability execution の実行性能を監視し、SLO 違反の検知と自動復旧（Self-healing）の仕組みを運用できる。

- **Step 1: 観測**
  - `work/metrics/`（`execution-metrics.jsonl` / `resource-usage.jsonl`）のデータ構造理解
  - `pnpm dashboard`（`scripts/sovereign_dashboard.ts`）の実行と分析
- **Step 2: 改善**
  - `pnpm check` の静的ゲートと TODO/FIXME スキャンによる技術負債の定量的評価
  - リバウンドレシピ (`knowledge/product/orchestration/remediation-recipes.json`) の更新
- **Step 3: 自動化**
  - `pipelines/chaos-*.json`（`chaos-actuator-down` / `chaos-network-partition` / `chaos-secret-missing`）による耐障害性テストの実施

## 3. Security Reviewer (セキュリティ・レビュアー)

**目標**: 知的財産の保護、機密情報の漏洩防止、およびセキュアなコード品質を維持する。

- **Step 1: 監査基盤**
  - `libs/core/pii-scrubber.ts` とインジェスト時の PII ゲートによるドキュメントスキャン
  - `code-actuator` と `secret-actuator` を使った governed security review の運用
- **Step 2: 知財管理**
  - `pnpm license:audit` による依存ライブラリのライセンスチェック
- **Step 3: 防御**
  - `knowledge/product/governance/security-policy.json` / `security-posture.json` を含むセキュリティ要件の適用

## 4. Strategic Deal-Maker (ビジネス・ストラテジスト)

**目標**: 技術的成果をビジネス価値（ROI）に翻訳し、ステークホルダーへの報告と投資判断を支援する。

- **Step 1: 価値の言語化**
  - `knowledge/product/orchestration/global_actuator_index.json`（現行テレメトリ正本）からのコスト削減効果の抽出
  - `pnpm check` の静的ゲート結果によるリスクの定量的把握
- **Step 2: ロードマップ策定**
  - `docs/PRODUCTIZATION_ROADMAP.md` と `knowledge/public/strategy/` を用いたフェーズ分け
- **Step 3: 外部連携**
  - `pipelines/agentic-source-code-review.json` を用いたエコシステム評価

---

_最終更新日: 2026年10月4日_
