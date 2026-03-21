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
