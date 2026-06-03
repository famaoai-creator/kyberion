# Architecture ADF

`architecture-adf.schema.json` は renderer 非依存のアーキテクチャ図 contract です。

想定用途:

- Terraform などの IaC から中立 graph を抽出する
- `mermaid` / `d2` / `draw.io` に同じ構造を流す
- provider や icon pack に依存しすぎない上位表現を保つ

最小の重要フィールド:

- `provider`
- `render_hints`
- `nodes[].type`
- `nodes[].icon_key`
- `nodes[].boundary`
- `nodes[].group`
- `edges[].protocol`
- `edges[].port`

サンプルは `architecture-adf.example.json` を参照。
