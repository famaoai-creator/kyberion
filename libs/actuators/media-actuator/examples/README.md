# Media-Actuator Examples

Media-Actuator 固有のサンプル pipeline を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- Media-Actuator 専用の検証・サンプル・再現用 pipeline は `libs/actuators/media-actuator/examples/` に置く

実行例:

```bash
node dist/libs/actuators/media-actuator/src/index.js --input libs/actuators/media-actuator/examples/executive-summary-pptx.json
```

利用可能な examples:

- `executive-summary-pptx.json`:
  共通 theme と executive-summary pattern を使って PPTX を生成
- `marketing-deck-pptx.json`:
  Kyberion marketing deck pattern からそのまま PPTX を生成
- `strategic-roadmap-pptx.json`:
  strategic-roadmap pattern に独自 content を差し込んで PPTX を生成
- `diagram-mermaid-architecture.json`:
  Mermaid source を SVG に render
- `diagram-d2-process.json`:
  D2 source を SVG に render
- `aws-terraform-drawio.json`:
  AWS 系グラフからローカル完結の `.drawio` を生成
- `seat-chart-xlsx.json`:
  座席表のネイティブ XLSX を生成
- `project-wbs-xlsx.json`:
  WBS のネイティブ XLSX を生成
- `raid-register-xlsx.json`:
  RAID 管理表のネイティブ XLSX を生成
- `pptx-master-theme-extract.json`:
  生成した PowerPoint から theme と master placeholder を抽出し、context JSON に保存
- `pptx-master-theme-reuse.json`:
  抽出した theme / master をベースに派生 PowerPoint を生成
- `document-brief-proposal-pptx.json`:
  canonical な `document-brief` から提案書 PPTX を生成する。`document_outline_from_brief -> brief_to_design_protocol -> generate_document` の正規ルートを使う
- `proposal-storyline-pptx.json`:
  proposal storyline の inspection / debug 用。旧来の narrative 展開を確認する互換サンプル
- `document-brief-mermaid-diagram.json`:
  canonical な `document-brief` から Mermaid 図を生成する。`diagram / architecture-diagram / mmd` で区別する
- `document-brief-d2-diagram.json`:
  canonical な `document-brief` から D2 図を生成する。`diagram / process-diagram / d2` で区別する
- `document-brief-drawio-diagram.json`:
  canonical な `document-brief` から Draw.io 図を生成する。`diagram / architecture-diagram / drawio` で区別する
- `document-brief-wbs-spreadsheet.json`:
  canonical な `document-brief` から XLSX トラッカーを生成する。`spreadsheet / tracker / xlsx` で区別する
- `document-brief-semantic-tracker-spreadsheet.json`:
  canonical な `document-brief` から semantic payload だけで XLSX トラッカーを生成する。protocol file を必須にしない
- `document-brief-report-docx.json`:
  canonical な `document-brief` から DOCX レポートを生成する。`document / report / docx` で区別する
- `document-brief-report-pdf.json`:
  canonical な `document-brief` から PDF レポートを生成する。`document / report / pdf` で区別する
- `document-brief-invoice-pdf.json`:
  canonical な `document-brief` から請求書 PDF を生成する。区別は `artifact_family / document_type / document_profile / render_target / layout_template_id` で行う
