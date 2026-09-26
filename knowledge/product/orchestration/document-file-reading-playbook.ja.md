---
title: ドキュメントファイル読み取りプレイブック（PDF / PPTX / XLSX / DOCX → テキスト・表・OCR）
category: Orchestration
tags: [orchestration, media-actuator, ingest-actuator, pdf, pptx, xlsx, docx, ocr, ingest]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-25
role_affinity: [ecosystem_architect, knowledge_steward, researcher, analyst, mission_controller]
phase_affinity: [alignment, execution]
---

# ドキュメントファイル読み取りプレイブック

エージェントが Office 文書や PDF を**読む**とき（質問に答える・要約する・`knowledge/` に取り込む）に、どのエンジンを使うか。そして誤った手段を選んだときに時間を失う罠をまとめる。`read` は `.html` / `.htm` / `.md` / `.txt` も読む（URL は拒否。先に `network:fetch` で保存する）。画像・音声・動画には専用コマンド（`see` / `listen` / `watch`）がある — [perception-playbook.ja.md](./perception-playbook.ja.md) を参照。正本は英語版 [document-file-reading-playbook.md](./document-file-reading-playbook.md)。

## 1. まず目的を決める

| 目的                                                             | 使うもの                                                                                                       | 出力                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| その場で読む・答える・要約する（保存しない）                     | `pnpm kyberion read <file> [--ocr]`                                                                            | 標準出力に Markdown（`--json` で形式・タイトル・表・警告） |
| 同じことをパイプライン内で                                       | `media:document_digest { path, ocr? }`                                                                         | コンテキスト上の Markdown                                  |
| 後続処理用の構造化データ（レイアウト・画像・スライド単位の項目） | `media:pdf_extract`, `media:pptx_slide_text`, `media:pptx_extract`, `media:xlsx_extract`, `media:docx_extract` | コンテキスト上の design protocol / スライドレコード        |
| テナントのナレッジとして取り込む（統制・台帳付き）               | `pnpm ingest --tenant <slug> --file <path> [--ocr]`                                                            | ナレッジカード + 資産台帳レコード                          |

`kyberion read`・`document_digest`・取込儀式は同じ読み取り関数（`@agent/core/document-reader`）を共有するので、どこから読んでも同じ結果になる。`unzip` / `pdftotext` / python-docx / 正規表現による自作抽出はしない。シェルポリシー（`document-hand-extraction`）が拒否し、この文書へ案内する。`knowledge/confidential/{tenant}/` へ入れる正規の経路は取込儀式だけ。

## 2. 形式別のエンジン

### PDF — ネイティブ PDF エンジン（`libs/core/src/native-pdf-engine/`）

- `media:pdf_extract { path, ocr? }` → `PdfDesignProtocol`。ページごとのテキスト（pdf-parse の整形テキストを統合）、位置付きテキスト要素、**配置画像を PNG/JPEG として抽出**（ページ上の位置付き）。
- `media:document_digest { path, ocr? }` → ページ区切り・推定表・メタデータ付き Markdown。
- `ocr: true`（または `{ enabled, language, mode, min_area_ratio }`）でページ内の画像（貼り付けた表・グラフ・スクリーンショット）を OCR する。ページ面積の 3% 未満（ロゴ等）は対象外。既定はローカルのみ（`training_use: 'local_only'`、Apple Vision / tesseract）。請求書など個人情報を含む文書は一律拒否せず、`tier: 'confidential'` または `tier: 'personal'` とテナントを指定して、その tier の知識として保持できる。外部 OCR を使う場合だけ `training_use: 'zero_retention'` または `training_use: 'training_eligible'` を明示し、通常のテナント外部送信許可を通す。
- スキャン PDF（1 ページ 1 枚の全面画像）: `media:pdf_to_pptx_design` に `hints.features.fullPageImageOcrOverlay: true`。このオーバーレイはページの一部にある画像では**発火しない**ので、その場合は上の `ocr: true` を使う。
- PDF → 表グリッド: `media:pdf_to_xlsx_design`。
- ページ操作のみ（分割・結合・回転・暗号化等）: `pdf_*` の pypdf 系 op。内容は読まない。

### PPTX — ネイティブ PPTX エンジン（`extractPptxSlides`）

- `media:pptx_slide_text { path, ocr? }` → スライドごとのレコードを**表示順**で返す（`position`。`slide_index` は `slideN.xml` のファイル番号のまま）。`hidden`、`shapes_text`（段落は改行区切り）、`tables`（セルの行列）、`notes_text`（スピーカーノート）、`image_parts`、`concatenated` を含む。
- `ocr: true` でスライド画像を OCR する。EMF/WMF（Excel 範囲の貼り付けで Office が保存する形式）は LibreOffice で PNG 化してから読む。それでも読めない画像は `ocr_skipped` に載る。「OCR テキストが無い」を「図が無い」と読まないこと。
- `media:pptx_extract` → テキストだけでなく配置・テーマ・アセットまで要るときのフル design protocol。

### DOCX / XLSX — ネイティブ読み取り（`libs/core/src/docx-utils.ts`・`xlsx-utils.ts`）

`native-docx-engine` / `native-xlsx-engine` は**書き出し**用。読み取りは `distillDocxDesign` / `distillXlsxDesign`（JSZip ベース、mammoth / exceljs 不使用）で、パスでもバイト列でも受け取れる。

- `media:docx_extract { path, image_dir?, embed_images? }` → `DocxDesignProtocol`（本文ブロック・表・番号付け・スタイル・図）。画像はファイルに書き出され、`drawing.imagePath` で参照される。既定の置き場所は `active/shared/tmp/native-docx/images/<文書ハッシュ>/`（24 時間 TTL）、`image_dir` で変更できる。TTL を過ぎてから Word に書き戻す可能性があるなら `embed_images: true` で自己完結の設計データにする（base64 の `imageData` を内包。画像の多い文書では数 MB）。書き出しエンジンはどちらの形式も受け付ける。
- `media:document_digest`（docx）→ 見出し・箇条書き・改行（`<w:br/>`）・**表**を保った Markdown。画像は `_[image: media/imageN.png]_` の目印になる。
- `media:xlsx_extract { path, sheet?, range?, values_only? }`。シート・範囲・`values_only` を指定すると値だけの軽量な射影になる。結合セルは左上のセルだけが値を持つ。
- `media:document_digest`（xlsx）→ 表示中のシートごとに Markdown の表 1 つ。非表示の行・シートは除外し、セル内改行は `<br>` にする。数値はセルの表示形式で出す（`33.5%`・`1,234,567`・`▲28,957`・`2026/05/31`。保存されている生の値ではない）。

### 取込儀式（`pnpm ingest`）

- 形式: `docx`, `pdf`, `xlsx`, `pptx`, `html`, `slack_thread`, `markdown`, `text`（拡張子から推定）。
- `--ocr`（pptx・pdf・docx）: 埋め込み画像をローカル OCR し、`Image text (OCR — unverified)` ブロックとしてカードに入れる（docx は各画像の目印の位置に入る）。「スライドを Word に貼っただけ」の文書は本文がすべて画像なので必須。
- docx / xlsx は `document_digest` と同じネイティブ読み取りを通る。mammoth / exceljs はネイティブが読めないファイルのときだけの予備。
- 必ず最初に `--dry-run`（`--propose-tier` を付けると階層提案と PII 検出結果が見える）。`--source-id` は資料ごとに固定し、再取込が分岐ではなく上書き版（supersede）になるようにする。
- `--source-id` の既定値はファイル名。別の作業フォルダにコピーした同じ資料も同じ資産として扱われる。以前に明示の id（例: `downloads/<name>`）で取り込んだカードはその id のままなので、置き換えるときは同じ id を渡す。
- `--target` を省略すると、dry-run がテナントの既存フォルダを一覧表示する。既定の `ingest/` ではなく、そこから選ぶ。
- `--reparse`: 読み取りが改善されたとき（表・表示形式・OCR の扱いなど）、取込済みで原本が変わっていない資料を再解析し、カードを新しい版で置き換える（version +1、変換履歴に `reparse`）。それ以外の重複には使えない。

## 3. 単発で読むときの実行方法

```bash
mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<file> active/shared/tmp/<job>/
pnpm kyberion read active/shared/tmp/<job>/<file>            # Markdown
pnpm kyberion read active/shared/tmp/<job>/<file> --ocr      # 画像内の文字も読む
pnpm kyberion read active/shared/tmp/<job>/<file> --json --out active/shared/tmp/<job>/read.json
pnpm kyberion read active/shared/tmp/<job>/<file> --images active/shared/tmp/<job>/images  # 図を画像ファイルで
```

`read` は実行時の初期化を省き、ログを標準出力に出さない（小さなファイルで 1〜2 秒。`--verbose` でログを戻せる）ので、出力をそのままパイプで渡せる。警告（OCR していない画像・非表示シート・読めなかった画像）は Markdown の後ろに `> [read] …` の行で出る。「図が無い」と決めつけず、警告に従って対応する（例: `--ocr` を付けて再実行）。パイプライン JSON では `"op": "media:document_digest"` を使う。文書を読むためにスクリプトや ADF ファイルを書く必要はない。

## 4. 罠（すべて実際に踏んだもの）

1. **入力はリポジトリ内に置く。** `~/Downloads/...` は拒否される。先に一意な名前の `active/shared/tmp/<job>/` へコピーする。
2. **最終版を選ぶ。** 資料は多数のドラフトで届く。同日の `final.pdf` は最新の `DraftN.pptx` より優先されることが多い。更新日時を確認し、迷ったら聞く。
3. **表の OCR はラベルと数値の対応が崩れる。** Apple Vision は列を上から下へ読むため、貸借対照表や損益計算書は「ラベルの列挙 → 数値の列挙」になる。財務表は画像を見て Markdown の表に転記する。図は `--images <dir>` で PNG として取り出せる（EMF/WMF も変換済み）ので、パッケージを手で展開する必要はない。OCR は文章主体の画像（アセスメント・契約書）に使う。
4. **グラフ画像の OCR は崩れる。** グラフに印字された数値ラベルだけを記録し、ラベルの無い点は原本で読む必要があると明記する。
5. **confidential 書込の実行主体。** `pnpm ingest` には `KYBERION_PERSONA=ecosystem_architect MISSION_ROLE=mission_controller` が必要。儀式は最初にこれを確認し、足りなければポリシー違反を出さずに正しい実行方法を示して止まる。ロールを当て推量で試さないこと（10 分で 3 回の違反でキルスイッチが作動する）。
6. **PII。** 取込ゲートはメール・電話・口座・住所をマスクし、カード番号・マイナンバーをブロックする。氏名は検出しない。契約書の OCR や PDF メタデータ（作成者）には氏名が載りうるので、コミット前に確認する。
7. **抽出画像を片付ける。** PDF の画像は `active/shared/tmp/native-pdf/images/<文書ハッシュ>/`、PPTX のアセットは `active/shared/tmp/actuators/media-actuator/` に出る。テナントの図表を 24 時間 TTL の間そこへ残さず、カードをコミットしたら自分が作ったディレクトリを消す。
8. **パスワード付きの Office ファイル**（`file` で `CDFV2 Encrypted` と出る）は読めない。復号の op は無いので、再試行せず持ち主に復号済みのコピーを依頼する。
9. **元のファイル名のままコピーする。** 見出しの無い文書ではカードのタイトルがファイル名になる。`incident.docx` のような英数字への改名はそのままタイトルになってしまう。元の名前を保ち、` (1)` のようなコピー接尾辞だけ外す。
10. **テキストの取得方法を記録する。** カードに、どこがエンジンのテキストか、どこが OCR（未検証）か、どこが手作業の転記かを書き、読み手が何を再確認すべきか分かるようにする。
