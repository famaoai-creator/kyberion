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
KYBERION_BASE_ROLE=sovereign node_modules/.bin/tsx scripts/html-to-pptx/convert.ts <input.html> [output.pptx]
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

## 既存デッキのマスター/レイアウトを継承して新しいスライドを作る場合

`media:pptx_extract`（`distillPptxDesign`）で既存デッキのデザインを取り出し、要素を書き換えて `media:pptx_render` に渡すときの注意点です。

- **`media:pptx_inherit_template` を使う**。以下の手順（`rawParts` の削除、元スライドの除去、`pXmlLst` の除去、レイアウト番号の指定）をこの op がまとめて行います。パイプラインは `pptx_extract` → `pptx_inherit_template`（`slides: [{ elements, layout_from_slide | layoutIndex | layout_name }]`）→ `pptx_render` → `pptx_package_check` です。スクリプトからは `@agent/core/media/pptx-utils` の `inheritPptxTemplate(design, slides)` を呼びます。元のスライドをそのまま残すことはできません（`rawParts` がないとエンジンはすべてのスライドを `elements` から書くため）。元のスライドを残す場合は `pptx_filter_slides` または `pptx_replace_slides` を使います。
- **`rawParts` を必ず削除する**。`pptx_extract` の結果には元ZIPの全パーツ（`rawParts`）が入っています。`rawParts` が残っていると、エンジンは元ZIPをそのまま再構成し、既存スライドの `<a:t>` テキストを順番に置き換えるだけになります。追加・編集した要素は無視され、`rawSlideXml` のない新しいスライドは出力されません。マスター/レイアウトを継承するには `rawMasters` / `rawLayouts` / `rawThemeXml` / `masterMedia` を残し、`rawParts` だけを削除します。新しく作るスライドからは `rawSlideXml` と `pXmlLst` も外します。
- **キャンバスの寸法**は `presentation.xml` の `<p:sldSz>` から読みます。4:3 のデッキ（`cx="9144000" cy="6858000" type="screen4x3"`）は `canvas: { w: 10, h: 7.5 }` になります。2026-11-26 より前のエンジンは `type` 属性付きの `sldSz` を読めず、幅を 0 にしていました。
- **マスターID**は、継承したマスターに含まれる `sldLayoutId` と重ならない値をエンジンが割り当てます。重なると PowerPoint が修復を求めます（2026-11-26 に修正）。
- **段落の書式**: `\n` で区切ったテキストは複数の `<a:p>` になり、`align` / `lineSpacing` / `spaceBefore` / `spaceAfter` / `bullet` はすべての段落に付きます。2026-11-26 より前のエンジンは最初の段落にしか付けず、2行目以降が左揃えになっていました。
- **文字の収まりを確かめる**: `pptx_layout_preflight` と `pptx_render` は、手で組んだプロトコルでもすべてのテキストボックスを測ります（全角＝1em、和欧間の約 1/4em の空き、bodyPr の内側余白〔既定は左右 0.1in・上下 0.05in〕、chevron / homePlate / roundRect / ellipse などの文字領域、行の高さ＝サイズ×1.2×行間）。結果は `overflow`（文字が枠の外に出る）と `unexpected_wrap`（ラベル・中央揃えの行・行数ぴったりの枠で、改行を入れていない段落が折り返す）に分けて報告します。既定は報告だけです。止めるときは `text_fit: "error"`（overflow で失敗）または `"warn"`（両方で失敗）を指定します。描画後は `media:pptx_render_check`（`path` と、描画に使ったプロトコルの `design_from`）が LibreOffice で PDF に変換し、各ボックスの実際の行数と位置を比べます。`fail_on` の既定は `error` です。LibreOffice がない環境では `status: "unavailable"` を返し、事前の見積りだけを添えます。BIZ UD 系のフォントは欧文が約 1.25 倍広いため、`fontFamily` からこれを見分けます。和名（例: `BIZ UDPゴシック`）は LibreOffice が見つけられず別のフォントで描くことがあるので、LibreOffice で確かめるときは英名で指定します。
- **単位**: `cornerRadius` は EMU ではありません。0〜1 の値は短辺に対する割合（0.08 = 8%）、1 を超える値は OOXML のガイド値（50000 = 完全な角丸）として扱います。`lineSpacing` は 10 以下なら倍率（1.3 = 130%）、10 を超えるなら百分率（130 = 130%）です。

## 設計メモ・限界（v1）

- 描画済み PDF と照合できないテキストボックスがある場合、ほかに問題が見つからなければ `inconclusive` と未照合件数を返します。既定の `fail_on: "error"` は、照合対象があるのにすべて未照合の場合に失敗します。`warn` では一部が未照合でも失敗し、`never` では結果を報告します。

- **規約ベースの意味変換**であり、ピクセル忠実なブラウザ変換ではない（＝編集可能で軽量・オンブランド、汎用HTMLは対象外）。
- 依存ゼロの自作HTMLパーサ（`html-parse.ts`）。自己生成の整形式HTMLを前提（`<style>`/`<script>`はraw-text扱い）。cheerio/jsdom等は入れない（社用端末・パッチ受け渡し方針）。
- レイアウトはトップダウンのフロー＋高さ見積り。1スライドに収まらない章は「（続き）」スライドへ自動分割。
- **重要**: 長文はLibreOffice等でソフト折返しが行を重ねて描画されるため、テキストは事前に `hardWrap` で明示改行して渡している。
- 検証は LibreOffice（`soffice --convert-to pdf` → `pdftoppm`）で実レンダリングを画像確認するのが有効。

## ファイル

- `convert.ts` — op を呼ぶ薄いCLIラッパ
- 変換ロジック本体は `libs/actuators/media-actuator/src/html-deck-helpers.ts`（パーサ＋トークン抽出＋デッキモデル＋レイアウト＝op `deck_from_html` の実装）／テストは同 `src/index.test.ts` の `media:deck_from_html` describe
