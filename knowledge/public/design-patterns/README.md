# 🎨 Human-Centric Design Patterns Registry

このリポジトリは、人間向けの資料を作成する際の最適なデザインパターンを管理し、`Media-Actuator` と連携して一貫した視覚的アウトプットを提供するための知識ベースです。

## 🎯 用途別デザインパターン (Pattern Catalog)

| カテゴリ | 特徴 | 主な構成要素 | ターゲット |
| :--- | :--- | :--- | :--- |
| **Presentation** | 視認性、インパクト | キーワード、大きな図解、余白 | 全体会議、ピッチ |
| **Report** | 論理性、エビデンス | 精緻なグラフ、詳細テキスト、構造化データ | 意思決定者、詳細分析者 |
| **Infographic** | 情報凝縮、フロー | アイコン、プロセスマップ、要約 | クイック・リーディング用 |

## ⚙️ Media-Actuator 連携 (ADF-Driven Automation)

`Media-Actuator` に以下の ADF (Agentic Data Format) を渡すことで、パターンに応じた資料が自動生成されます。

### 使用例 (ADF Snippet)
```json
{
  "action": "generate_slide",
  "params": {
    "purpose": "presentation",
    "theme": "kyberion-dark",
    "content": {
      "title": "2026 Strategy",
      "body": ["Autonomous Evolution", "Secure Foundation"]
    }
  },
  "design_pattern_ref": "knowledge/public/design-patterns/presentation/high-impact-pitch.json"
}
```

## 📂 フォルダ構造
- `presentation/`: プレゼン資料用テンプレートとガイドライン
- `report/`: 報告書用フォーマット定義
- `infographic/`: 図解・プロセスマップ用定義
- `media-templates/`: Media-Actuator が参照する CSS/JSON スタイル定義

---
*Status: Managed under MISSION-DESIGN-PATTERNS*
