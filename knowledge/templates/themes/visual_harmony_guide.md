# ビジュアル・ハーモニー・ガイド (Visual Harmony Guide)

全視覚的資産（スライド、図解、UIプロトタイプ）で一貫した色味を保つための基準。

## 1. 共通パレット定義 (JSON)
`knowledge/templates/themes/palettes/<brand>.json` に以下の形式で定義する。

```json
{
  "primary": "#009944",
  "secondary": "#e67e22",
  "background": "#f9f9f9",
  "text": "#333333",
  "node_bg": "#ffffff",
  "node_border": "#009944"
}
```

## 2. 図解への適用 (Mermaid)
`diagram-renderer` は、Mermaid コードの先頭に以下の `init` ディレクティブを動的に挿入し、パレットを反映させる。

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#009944', 'lineColor': '#e67e22' }}}%%
```

## 3. スライドへの適用 (Marp)
`layout-architect` は、生成する CSS 内でパレットの色を変数として定義する。

```css
:root {
  --brand-primary: #009944;
}
```
