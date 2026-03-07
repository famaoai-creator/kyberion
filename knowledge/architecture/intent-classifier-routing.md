# Architecture: Intent Classifier Routing (Gateway Architecture)

## 1. 概要 (Overview)
AIエージェントが保有するスキルの数が増加するにつれ、全てのスキル定義をシステムプロンプトにロードすることは、コンテキスト窓の浪費と意思決定コストの増大（Capability Trap）を招く。本アーキテクチャは、推論コストを最小化しつつ、大規模なスキルセットを運用するための「ゲートウェイ・モデル」を定義する。

## 2. コア・コンポーネント
- **The Workhorses (Tier 1 Tools)**: 常にロードされる 5-7 個の汎用ツール（read, write, exec, search, edit, replace）。
- **Intent Classifier (Gateway)**: 主権者の自然言語入力をスキャンし、事前に定義された 146 個の専門スキルの中から最適なものを特定する軽量な推論レイヤー。
- **Mission Pipelines (Deterministic Logic)**: 特定された意図に基づき、スキルの実行順序、パラメータ、検証条件を記述した YAML 形式の実行計画。

## 3. 利点
- **Context Efficiency**: LLM は 146 個のツール定義を読む必要がなくなり、本来の推論（Task Reasoning）にトークンを集中できる。
- **Deterministic Reliability**: スキルの連鎖が YAML パイプラインとして固定されているため、推論の揺れ（Hallucination）による誤ったツール呼び出しを防げる。
- **Execution Speed**: 意思決定（どのアプローチをとるか）がゲートウェイで即座に完了するため、実行開始までのレイテンシが大幅に削減される。

---
*Standardized at Kyberion during Moltbook Technical Audit 2026-03*
