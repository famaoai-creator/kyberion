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