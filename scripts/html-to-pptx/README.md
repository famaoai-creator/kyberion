# html-to-pptx — 規約ベース HTML→PPTX（ADF op `media:deck_from_html`）

Kyberion のレポートHTMLを、**編集可能なネイティブPPTX**に変換します。スクリーンショットではなく、HTMLの `:root` デザイントークンを継承したシェイプ/テキスト/表として再構成します。

## 位置づけ（方式の方向づけ・2026-08-06 合意 → op昇格済み）

- **ADFファーストの原則を維持**。メディア出力は固定デザインプロファイル（`brief_to_design_protocol`）では表現力不足で良いデザインが出にくいため、**デザインシステム（トークン＋部品）ベースで `PptxDesignProtocol` を組み、`media:pptx_render` で描画**する方式に。
- **正式なADF op `media:deck_from_html` に昇格済み**（transform）。変換ロジックの正本は
  `libs/actuators/media-actuator/src/html-deck-helpers.ts`（純関数 `htmlToDeckProtocol`）。
  このディレクトリの `convert.ts` は op を呼ぶ薄いCLIラッパ。

## ADFパイプラインでの使い方（推奨）

```json
{ "op": "media:deck_from_html", "params": { "path": "report.html" } }        // -> last_pptx_design
{ "op": "media:pptx_render", "consumes": "last_pptx_design", "params": { "path": "out.pptx" } }
```

- 入力ソースは `params.path`（HTMLファイル）／`params.html`（インライン）／`params.from`（ctxチャネルのHTML文字列）のいずれか。
- `params.export_as` で出力チャネル名を上書き可（既定 `last_pptx_design`）。

## CLI（薄いラッパ）

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/html-to-pptx/convert.ts <input.html> [output.pptx]
```

出力省略時は `<input>.pptx`。内部で `deck_from_html → pptx_render` の2段パイプラインを生成・実行するだけ（CLIとpipelineで実装は共通）。

## 対応している規約（レポートHTMLの語彙 → スライド部品）

| HTML                                                     | スライド化                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `.confbar`                                               | 全スライド上部の機密バー                                   |
| `header.hero`（`h1`/`.kicker`/`.sub`/`.meta`）           | 表紙（濃紺）                                               |
| `<h2>`                                                   | 新しいスライドの見出し（＋アクセント下線）                 |
| `<h3>`                                                   | セクション内サブ見出し                                     |
| `<p>`（`.legend`は小さめ）                               | 段落                                                       |
| `.callout`（`.warn`/`.good`/無印）                       | 左アクセント帯付きコールアウト（警告/成功/情報）           |
| `table` / `.tblwrap>table`                               | 表（濃紺ヘッダ＋行、セル内 `.chip`/`.sev` は色付きチップ） |
| `.chip` / `.sev`（`c-*`/`s-*` = crit/high/med/low/zero） | 重大度チップ（roundRect＋色）                              |
| `<ul><li>`                                               | 箇条書き                                                   |
| `.kpis`/`.kpi`（`.big`/`.lbl`）                          | 数値バンド                                                 |
| `.grpttl`                                                | グループ見出し                                             |

デザイン色は入力HTMLの最初の `:root{ --bg/--accent/--crit/... }` から取得するため、同じトークン規約のHTMLは自動でオンブランドになります。

## 設計メモ・限界（v1）

- **規約ベースの意味変換**であり、ピクセル忠実なブラウザ変換ではない（＝編集可能で軽量・オンブランド、汎用HTMLは対象外）。
- 依存ゼロの自作HTMLパーサ（`html-parse.ts`）。自己生成の整形式HTMLを前提（`<style>`/`<script>`はraw-text扱い）。cheerio/jsdom等は入れない（社用端末・パッチ受け渡し方針）。
- レイアウトはトップダウンのフロー＋高さ見積り。1スライドに収まらない章は「（続き）」スライドへ自動分割。
- **重要**: 長文はLibreOffice等でソフト折返しが行を重ねて描画されるため、テキストは事前に `hardWrap` で明示改行して渡している。
- 検証は LibreOffice（`soffice --convert-to pdf` → `pdftoppm`）で実レンダリングを画像確認するのが有効。

## ファイル

- `convert.ts` — op を呼ぶ薄いCLIラッパ
- 変換ロジック本体は `libs/actuators/media-actuator/src/html-deck-helpers.ts`（パーサ＋トークン抽出＋デッキモデル＋レイアウト＝op `deck_from_html` の実装）／テストは同 `src/index.test.ts` の `media:deck_from_html` describe
