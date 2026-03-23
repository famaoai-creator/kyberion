# Human-Centric Design Patterns Registry

人間向け資料の最適なデザインパターンを管理し、`Media-Actuator` パイプラインと連携して一貫した視覚的アウトプットを提供するための知識ベース。

## Pattern Catalog

| カテゴリ | パターン ID | 対象 | エンジン |
| :--- | :--- | :--- | :--- |
| **Presentation** | `KYBERION-MARKETING-DECK` | クライアント・投資家 | pptx |
| **Presentation** | `PPTX-ROADMAP-01` | ステークホルダー・チーム | pptx |
| **Presentation** | `PPTX-VISUAL-ROADMAP-02` | ステークホルダー・チーム | pptx |
| **Presentation** | `PPTX-EXEC-BRIEF-01` | 経営層・ボード | pptx |
| **Presentation** | `PPTX-INVESTOR-PITCH-01` | 投資家・パートナー | pptx |
| **Presentation** | `PPTX-QBR-01` | 部門責任者・スポンサー | pptx |
| **Presentation** | `PPTX-CLIENT-PROPOSAL-01` | クライアント・調達 | pptx |
| **Presentation** | `PPTX-CASE-STUDY-01` | 営業・顧客成功・経営層 | pptx |
| **Presentation** | `PPTX-WORKSHOP-01` | ファシリテーター・プロジェクトチーム | pptx |
| **Presentation** | `STRAT-EXE-01` | 経営層 | puppeteer |
| **Presentation** | `REL-PROP-01` | クライアント | puppeteer |
| **Presentation** | `STRAT-ROAD-01` | ボードメンバー | mermaid |
| **Spreadsheet** | `XLSX-EXEC-DASHBOARD-01` | 経営層・ボード | xlsx |
| **Spreadsheet** | `XLSX-OPS-TRACKER-01` | オペレーター・PM | xlsx |
| **Spreadsheet** | `XLSX-QBR-WORKBOOK-01` | 部門責任者・スポンサー | xlsx |
| **Spreadsheet** | `XLSX-BUDGET-ACTUAL-01` | 財務・経営 | xlsx |
| **Report** | `TECH-RCA-01` | エンジニアリング | mermaid |
| **Report** | `ANA-PERF-01` | アナリスト | chartjs |
| **Infographic** | `INFO-PROCESS-01` | 社内オペレーション | d2 |
| **Infographic** | `TECH-ARCH-01` | アーキテクト | d2 |

## Media-Actuator Pipeline 連携

パターンからの資料生成は `transform` ステップを経由して行う。

### CLI からの生成

```bash
# デフォルト（Marketing Deck）
node dist/scripts/generate_marketing_deck.js

# カスタムパターン + テーマ指定
node dist/scripts/generate_marketing_deck.js \
  --pattern knowledge/public/design-patterns/presentation/executive-summary.json \
  --theme kyberion-standard \
  --output active/shared/exports/exec-summary.pptx
```

### ADF Pipeline (JSON)

```json
{
  "action": "pipeline",
  "steps": [
    { "type": "transform", "op": "apply_theme", "params": { "theme": "kyberion-standard" } },
    { "type": "transform", "op": "apply_pattern", "params": { "pattern_path": "knowledge/public/design-patterns/presentation/kyberion-marketing-deck.json" } },
    { "type": "transform", "op": "merge_content", "params": { "output_format": "pptx" } },
    { "type": "apply", "op": "pptx_render", "params": { "path": "active/shared/exports/output.pptx" } }
  ]
}
```

### Bridge API (HTTP)

```bash
# パターン一覧
curl http://localhost:3031/design/patterns

# テーマ一覧
curl http://localhost:3031/design/themes

# パターンから資料生成
curl -X POST http://localhost:3031/design/generate \
  -H 'Content-Type: application/json' \
  -d '{"pattern_path": "knowledge/public/design-patterns/presentation/kyberion-marketing-deck.json", "theme": "kyberion-standard"}'
```

## フォルダ構造

```
design-patterns/
  presentation/   # プレゼン資料パターン
  report/         # 報告書パターン
  infographic/    # 図解・フロー可視化パターン
  media-templates/
    themes.json   # カラーパレット・フォント・ブランドアセット定義
    excel-sheet-themes.json # Excel workbook / sheet UX の共通規律
```

## Transform Operations

| Op | 説明 |
| :--- | :--- |
| `apply_theme` | themes.json からテーマをロードし `active_theme` に設定 |
| `apply_pattern` | デザインパターン JSON をロードし `active_pattern` に設定 |
| `merge_content` | テーマ + パターン + コンテンツを統合してレンダリング可能なプロトコルを生成 |
| `set` | コンテキスト変数を任意に設定 |

## Page Layouts For PPTX

PPTX パターンでは、テーマとは別に `page_layouts` でページ単位のレイアウトを定義できる。

- `page_layouts.<id>.elements`: そのページで固定表示する背景帯・装飾・ガイド要素
- `page_layouts.<id>.backgroundFill` / `bgXml`: ページ背景
- `page_layouts.<id>.placeholders.title|body|visual`: 既定プレースホルダの位置と style
- `content_data[].page_layout`: 各ページが使うレイアウト ID

例:

```json
{
  "page_layouts": {
    "cover": {
      "backgroundFill": "F8FAFC",
      "elements": [
        { "type": "shape", "shapeType": "rect", "pos": { "x": 0, "y": 0, "w": 10, "h": 0.3 }, "style": { "fill": "0F172A" } }
      ],
      "placeholders": {
        "title": { "pos": { "x": 0.8, "y": 1.0, "w": 8.4, "h": 0.9 }, "style": { "align": "left" } },
        "body": false
      }
    }
  },
  "content_data": [
    { "page_layout": "cover", "title": "Quarterly Roadmap" }
  ]
}
```

## PPTX Template Library

PowerPoint としてそのまま利用できるテンプレート群は次で管理する。

- マニフェスト: `knowledge/public/design-patterns/presentation/pptx-template-library.json`
- 一括生成: `pnpm exec tsx scripts/generate_pptx_template_library.ts`
- 出力先: `active/shared/exports/pptx-template-library/`

## XLSX Template Library

Excel テンプレート群は次で管理する。

- マニフェスト: `knowledge/public/design-patterns/spreadsheet/xlsx-template-library.json`
- 一括生成: `pnpm exec tsx scripts/generate_xlsx_template_library.ts`
- 出力先: `active/shared/exports/xlsx-template-library/`

## Common Themes

共通 theme 定義は `media-templates/themes.json` に集約する。

- `kyberion-standard`: 汎用の標準テーマ
- `kyberion-sovereign`: 役員向け・戦略資料向けの濃色アクセント
- `executive-neutral`: 白背景ベースの意思決定資料向け
- `forest-briefing`: ロードマップや運用報告向け
- `sunrise-report`: 明るめのレポート・要約資料向け

## Excel Sheet Themes

Excel 系は `themes.json` だけでは足りず、`sheet UX` の規律も別に持つ。

- `executive-sheet`: 上部 KPI 帯を持つ意思決定用 workbook
- `operator-tracker`: 更新頻度が高い WBS / RAID 向け
- `print-layout-sheet`: 配布・印刷前提の座席表向け

---
*Status: Managed under MISSION-DESIGN-PATTERNS*
