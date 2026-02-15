# ビジュアル・ハーモニー・ガイド (Visual Harmony Guide) - Proposer Edition

## 1. 提案者ブランドの定義

`knowledge/templates/themes/proposer/palettes/<proposer-name>.json` に提案者側のアイデンティティを定義する。

## 2. ブランド適用ロジック

全スキルは以下の優先順位でスタイルを適用する。

1. **ベーステーマ**: 常に「提案者ブランド」のスタイル（フォント、基本レイアウト、フッター）をベースとする。
2. **アクセント**: 図解の特定ノードやスライドの「ポイント」において、必要に応じて「クライアントブランド」の色を混ぜる。
3. **フッター/署名**: 常に提案者ブランドの情報（例：Copyright [Proposer]）を表示する。

## 3. 設定方法

`GEMINI.md` または実行時の命令で `proposer_context` を指定する。
例：「提案者：Gemini-Lab として資料を作成せよ」
-> `knowledge/templates/themes/proposer/palettes/gemini-lab.json` をロード。

## 4. Marp-to-PPTX Engineering (Strategic Standards)

プレゼン資料を自動生成する際、レンダリングの不整合を排除し、最高級の品質を維持するための定石。

### A. フォント統一の原則 (Font Unification)
英日・数字が混在するスライドでは、文字の高さとベースラインを完全に一致させるため、特定の高品質ゴシック体（例：`'Hiragino Sans'`）への**全テキスト強制統一**を行う。これにより、捲る際の見出しのガタつきを 0 にする。

### B. HTMLタグによるサイズ固定 (HTML Override)
Marp 独自の画像構文（`![w:...]`）は、変換エンジンによって無視されるリスクがある。プロフェッショナルな資料では、標準の `<img>` タグと `height/width` 属性を使い、ピクセル単位でサイズを固定する。

### C. 図解の黄金比 (16:9 Aspect Ratio)
- **広域（ガント等）**: 1200x400px
- **標準（構成図等）**: 800x500px
- **2カラム（組織図等）**: 550x450px
Mermaid 図解は、スライドの横長比率に合わせて必ず **`graph LR`（横長レイアウト）** で生成することを基本とする。

---
*Created: 2026-02-14 | Executive Reporting Maestro*
