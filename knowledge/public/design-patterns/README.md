# Human-Centric Design Patterns Registry

人間向け資料の最適なデザインパターンを管理し、`Media-Actuator` パイプラインと連携して一貫した視覚的アウトプットを提供するための知識ベース。

## Pattern Catalog

| カテゴリ | パターン ID | 対象 | エンジン |
| :--- | :--- | :--- | :--- |
| **Presentation** | `KYBERION-MARKETING-DECK` | クライアント・投資家 | pptx |
| **Presentation** | `STRAT-EXE-01` | 経営層 | puppeteer |
| **Presentation** | `REL-PROP-01` | クライアント | puppeteer |
| **Presentation** | `STRAT-ROAD-01` | ボードメンバー | mermaid |
| **Report** | `TECH-RCA-01` | エンジニアリング | mermaid |
| **Report** | `ANA-PERF-01` | アナリスト | chartjs |
| **Infographic** | `INFO-PROCESS-01` | 社内オペレーション | d2 |
| **Infographic** | `TECH-ARCH-01` | アーキテクト | d2 |

## Media-Actuator Pipeline 連携

パターンからの資料生成は `transform` ステップを経由して行う。

### CLI からの生成

```bash
# デフォルト（Marketing Deck）
npx tsx scripts/generate_marketing_deck.ts

# カスタムパターン + テーマ指定
npx tsx scripts/generate_marketing_deck.ts \
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
```

## Transform Operations

| Op | 説明 |
| :--- | :--- |
| `apply_theme` | themes.json からテーマをロードし `active_theme` に設定 |
| `apply_pattern` | デザインパターン JSON をロードし `active_pattern` に設定 |
| `merge_content` | テーマ + パターン + コンテンツを統合してレンダリング可能なプロトコルを生成 |
| `set` | コンテキスト変数を任意に設定 |

---
*Status: Managed under MISSION-DESIGN-PATTERNS*
