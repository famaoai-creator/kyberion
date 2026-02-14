# ロール別教育ロードマップ (Learning Paths by Role)

Gemini エコシステムへ参加するメンバーが、それぞれの役割において専門性を発揮するための学習パス。

## 1. Ecosystem Architect (エコシステム・アーキテクト)
**目標**: モノレポ全体の構造を理解し、新規スキルの設計、共通基盤の改善、およびスケーラビリティの確保ができるようになる。

- **Step 1: 基礎理解**
  - `GEMINI.md` の熟読（動作原理とガバナンス）
  - `scripts/lib/core.cjs` のコードリーディング（標準ユーティリティ）
- **Step 2: スキル開発**
  - `autonomous-skill-designer` を用いた新規スキルのプロトタイピング
  - `SKILL.md` の標準フォーマット習得
- **Step 3: 高度な管理**
  - `scripts/check_knowledge_integrity.cjs` を用いた整合性維持
  - 依存関係グラフ (`dependency-grapher`) の分析

## 2. Reliability Engineer (SRE / 信頼性エンジニア)
**目標**: スキルの実行性能を監視し、SLO 違反の検知と自動復旧（Self-healing）の仕組みを運用できる。

- **Step 1: 観測**
  - `evidence/performance/` のデータ構造理解
  - `node scripts/generate_performance_dashboard.cjs` の実行と分析
- **Step 2: 改善**
  - `generate_debt_report.cjs` を用いた技術負債の定量的評価
  - リバウンドレシピ (`knowledge/orchestration/remediation-recipes.json`) の更新
- **Step 3: 自動化**
  - `chaos-monkey-orchestrator` による耐障害性テストの実施

## 3. Security Reviewer (セキュリティ・レビュアー)
**目標**: 知的財産の保護、機密情報の漏洩防止、およびセキュアなコード品質を維持する。

- **Step 1: 監査基盤**
  - `scripts/scan_pii_in_docs.cjs` によるドキュメントスキャン
  - `security-scanner` スキルの運用
- **Step 2: 知財管理**
  - `license-auditor` による依存ライブラリのライセンスチェック
- **Step 3: 防御**
  - `post-quantum-shield` を含む先端セキュリティ要件の適用

## 4. Strategic Deal-Maker (ビジネス・ストラテジスト)
**目標**: 技術的成果をビジネス価値（ROI）に翻訳し、ステークホルダーへの報告と投資判断を支援する。

- **Step 1: 価値の言語化**
  - `PERFORMANCE_DASHBOARD.md` からのコスト削減効果の抽出
  - `generate_debt_report.cjs` によるリスクの金額換算の理解
- **Step 2: ロードマップ策定**
  - `strategic-roadmap-planner` を用いたフェーズ分け
- **Step 3: 外部連携**
  - `github-repo-auditor` を用いたエコシステム拡大の評価

---
*最終更新日: 2026年2月14日*
