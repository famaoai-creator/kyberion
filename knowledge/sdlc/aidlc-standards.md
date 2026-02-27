# AIDLC Standards: AI Development Life Cycle

このドキュメントは、AI モデルおよび AI 搭載アプリケーションの開発・運用におけるライフサイクル (AIDLC) を定義し、伝統的な SDLC に AI 特有のプロセスを統合するための標準規約である。

## 1. AIDLC のフェーズ

### 1.1 要件定義 & データ設計 (Data Strategy)
- AI が解決するビジネス課題の定義。
- 必要なデータの種類、量、品質（バイアスの有無）の設計。
- プライバシー保護（PII 除去）の設計。

### 1.2 データ収集 & 前処理 (Data Ops)
- データの収集、クレンジング、アノテーション（ラベル付け）。
- データセットのバージョン管理（DVC 等の活用）。

### 1.3 モデル開発 & 学習 (Model Training)
- アルゴリズム選定、ハイパーパラメータチューニング。
- **Experiment Tracking**: 学習ログ、パラメータ、モデルの成果物を記録。

### 1.4 評価 & 検証 (Evaluation & Testing)
- **Model Validation**: 精度、想起率、F1スコア等の定量的評価。
- **Robustness Testing**: 入力データへの微小な変化に対する耐性テスト。
- **Fairness & Bias Check**: 特定の属性に対する偏りの有無を確認。

### 1.5 デプロイ & 推論 (Deployment)
- A/B テストやカナリアリリースによる段階的なデプロイ。
- 推論レイテンシとスループットの最適化。

### 1.6 モニタリング & 再学習 (Monitoring & Retraining)
- **Data Drift**: 入力データの分布変化の検知。
- **Model Drift**: 時間経過による精度の低下を検知し、再学習をトリガー。

## 2. AIDLC と SDLC の統合

AI は「不確実性」を伴うため、確定的（Deterministic）な従来のコードテストに加え、確率的（Probabilistic）な継続的評価が必須となる。

- **CI/CD/CT**: Continuous Integration, Continuous Delivery に加え、**Continuous Training** をパイプラインに組み込む。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
