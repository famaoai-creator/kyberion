# Source Code Analysis Protocol (SCAP)

## 1. Overview

本プロトコルは、ソフトウェア資産の品質、保守性、および安全性を客観的に評価するための体系的な解析プロセスを定義する。解析は「全体から詳細へ」の階層的アプローチを採用する。

## 2. Analysis Layers & Viewpoints

### Layer 1: Macro-Architecture (全体構造)

- **Dependency Graph**: モジュール間の循環参照の有無、境界の明確さ。
- **Single Responsibility (SRP)**: クラスや関数が単一の目的を達成しているか。
- **Technology Alignment**: プロジェクト標準の技術スタック（@agent/core 等）への準拠。

### Layer 2: Meso-Logic (論理フロー)

- **Cyclomatic Complexity**: 条件分岐の複雑さが許容範囲内か（推奨: 10以下）。
- **Data Lineage**: 入力データがどのように変換され、どこへ出力されるかの透明性。
- **Side Effects**: グローバル状態の書き換えや、予期せぬ外部干渉の有無。

### Layer 3: Micro-Cleanliness (可読性・品質)

- **Naming Accuracy**: 変数・関数名がその役割を正確に記述しているか。
- **Cognitive Load**: 一読してロジックを理解できるか。冗長なネストの排除。
- **Test Coverage**: 境界条件（null, empty, max/min）を網羅するテストの存在。

### Layer 4: Safety & Compliance (安全性)

- **Secret Management**: APIキー等のハードコードの排除（Tier Guard 準拠）。
- **Vulnerability Patterns**: eval(), unsafe exec() 等の危険な関数の使用禁止。
- **Input Validation**: 外部からの入力に対するサニタイズの徹底。

## 3. Systematic Execution Process

### Phase 1: Context Discovery (背景把握)

- `README.md`, `SKILL.md` を読み、解析対象の「意図（Purpose）」を特定する。
- `package.json` で依存関係を確認し、エコシステム内の位置付けを把握する。

### Phase 2: Static Structural Audit (静的解析)

- ディレクトリ構造のスキャン。
- リンター（ESLint）、型チェッカー（tsc）による形式的エラーの抽出。

### Phase 3: Behavioral Logic Review (論理レビュー)

- 主要なパス（Happy Path）とエラーパスのコードリーディング。
- データの不変性（Immutability）が保たれているかの確認。

### Phase 4: Quantitative Scoring (定量評価)

- `quality-scorer` や `complexity-analyzer`（計画中）による数値化。
- 改善が必要な箇所（Needs Work）の特定。

---

_Maintained by Gemini Engineering Standards Board_
