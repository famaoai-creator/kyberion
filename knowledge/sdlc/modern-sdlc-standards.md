# Modern SDLC Standards: Agile, Shift-Left & Quality-First

このドキュメントは、現代的なソフトウェア開発ライフサイクル (SDLC) における、スピードと品質を両立させるための標準規約である。

## 1. 開発モデルの変遷

### Waterfall (伝統的)
- 計画、設計、実装、テスト、運用の線形プロセス。
- **課題**: 変更への適応が遅く、テスト段階で重大な欠陥が発覚するリスクが高い。

### Agile / Scrum (現代的)
- 短い反復（スプリント）で価値を段階的に提供。
- **要点**: 変化を許容し、常に動作するソフトウェアを優先する。

## 2. Shift-Left Testing & Security

「Shift-Left」とは、品質検証とセキュリティチェックを開発のより早い段階（左側）に移動させること。

- **要件定義段階**: 受入基準 (Acceptance Criteria) と非機能要件の明確化。
- **設計段階**: 脅威モデリングとアーキテクチャレビュー。
- **実装段階**: 単体テスト、静的解析 (SAST)、セキュリティスキャン。
- **コミット前**: `pre-commit` フックによる自動チェック。

## 3. 分岐戦略 (Branching Strategy)

### GitHub Flow (推奨)
- `main` ブランチは常にデプロイ可能な状態を維持。
- 新機能は `feat/`、修正は `fix/` ブランチで開発。
- プルリクエスト (PR) によるコードレビューと CI パスを必須化。

## 4. 継続的な改善 (Continuous Feedback)

- **Post-Mortem**: 障害だけでなく、成功したプロジェクトからも学ぶ。
- **Metrics-Driven**: 開発速度（Velocity）、デプロイ頻度、変更失敗率などの指標を追跡。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
