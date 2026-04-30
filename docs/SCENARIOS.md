# Usage Scenarios / Kyberion 活用シナリオ集

Each scenario demonstrates how multiple actuators and capability flows chain together to automate complex workflows. These scenarios map to specific personas and can be packaged as [Mission Playbooks](knowledge/public/orchestration/mission-playbooks).

本リポジトリに実装されたアクチュエータ群と capability flow を組み合わせることで、ソフトウェア開発ライフサイクルの各フェーズを高度に自動化できます。

| #   | Scenario                                  | Primary Persona | Related Playbook                                                              |
| --- | ----------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| 1   | Asset Visualization & Reverse Engineering | Engineer        | —                                                                             |
| 2   | Requirements-to-Test Quality Pipeline     | PM / Auditor    | [product-audit](knowledge/public/orchestration/mission-playbooks/product-audit.md) |
| 3   | Automated UI Audit & Visual Report        | PM / Auditor    | [product-audit](knowledge/public/orchestration/mission-playbooks/product-audit.md) |
| 4   | Pre-commit Security Health Check          | Engineer        | —                                                                             |

## 1. 既存資産の可視化とリバースエンジニアリング

仕様書が未整備、あるいはレガシー化したプロジェクトの現状を迅速に把握します。

- **ステップ**:
  1. `code-actuator`: プロジェクトの構造やコード資産を収集・整形。
  2. `modeling-actuator`: DB定義、API定義、IaC などを構造化。
  3. `modeling-actuator` + `media-actuator`: インフラ構成を `architecture-adf` から図化。
  4. `media-actuator`: 抽出情報を整理し、現状分析レポートを生成。

## 2. 要件定義からテスト設計までの品質パイプライン

IPA/TIS標準に準拠した高品質なドキュメントとテスト設計をシームレスに生成します。

- **ステップ**:
  1. `orchestrator-actuator`: 要件レビューの execution brief と plan を構成。
  2. `modeling-actuator`: 構造化入力から UI flow / test inventory を抽出。
  3. `wisdom-actuator`: テスト観点や review 知識を inject して補強。
  4. `media-actuator`: テストケース管理表や報告資料を出力。

## 3. 自動UI監査とビジュアル・レポート

Webサイトの主要動線を自動確認し、エビデンス付きの報告書を作成します。

- **ステップ**:
  1. `browser-actuator`: Playwright でサイトを自動巡回し証跡を取得。
  2. `vision-actuator` または `media-generation-actuator`: 画像内容の解釈や OCR を補助。
  3. `media-actuator`: 証跡画像と結果を統合した資料を作成。

## 4. プリコミット・セキュリティ・ヘルスチェック

コードをコミットする前に、多角的な品質・安全性の監査を自動実行します。

- **ステップ**:
  1. `code-actuator`: Git 差分やコードベースを解析。
  2. `system-actuator`: 既存の scanner / lint / test command を governed shell として実行。
  3. `orchestrator-actuator`: 結果を要約し remediation plan へ落とす。
  4. `artifact-actuator`: 実行結果や evidence を governed artifact として保存。

---

## カスタムシナリオの作成 / Creating Custom Scenarios

These scenarios can be formalized as JSON ADF pipelines (`pipelines/*.json`) or mission playbooks (`knowledge/public/orchestration/mission-playbooks/`).

See also: [`intent_mapping.yaml`](knowledge/public/orchestration/meta-skills/intent_mapping.yaml) for intent-driven routing that can trigger these chains automatically from natural language.
