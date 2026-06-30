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
- `pdf-split-pages.json`:
  パスワード付き PDF を復号し、1ページずつ別ファイルへロスレス分割する（`pdf_split` op / pypdf backend）。パスワードは実行時に `PDF_PASSWORD` 環境変数で注入し、出力パスは repo-relative で返る

### `pdf_split` の前提

`pdf_split` op は pypdf に依存します。利用前に対象 python 環境へインストールしてください:

```bash
python3 -m pip install pypdf      # または venv に入れて KYBERION_PYTHON で指定
```

実行例（パスワードは argv に出さず環境変数経由）:

```bash
PDF_PASSWORD='＜PDFのパスワード＞' \
  node dist/libs/actuators/media-actuator/src/index.js \
  --input libs/actuators/media-actuator/examples/pdf-split-pages.json
```

params: `path`（入力PDF）, `password?`（`{{env.PDF_PASSWORD}}` や secret 参照可）, `out_dir?`（既定 `active/shared/tmp/pdf-pages/...`）, `prefix?`, `pad?`, `timeout_ms?`, `export_as?`。パスワードは stdin 経由で pypdf に渡され、プロセス引数には現れません。

### PDF ページ操作 op 一覧（pypdf backend）

`pdf_split` と同じ pypdf ブリッジ方式の op です。パスワードは stdin の JSON 経由で渡され argv に出ません。出力パスは repo-relative で返ります。すべて `capture` / `transform` / `sink` の各 role で呼べます。

| op | 主な params | 概要 |
|---|---|---|
| `pdf_merge` | `inputs: string[]`, `out?` | 複数PDFを1つに結合（順序は配列順） |
| `pdf_extract_range` | `path`, `pages`, `out?` | 指定ページのみ抽出（`pages` は 1始まり指定: `"1-3,7,10-"` / `"all"`） |
| `pdf_delete_pages` | `path`, `delete`, `out?` | 指定ページを削除して残りを出力 |
| `pdf_reorder` | `path`, `order`, `out?` | `order` の順にページを並べ替え |
| `pdf_rotate` | `path`, `pages?`(all), `angle?`(90), `out?` | 指定ページを 90 の倍数で回転 |
| `pdf_remove_password` | `path`, `password`, `out?` | 復号してパスワードを外した1ファイルを出力 |
| `pdf_encrypt` | `path`, `user_password`, `owner_password?`, `password?`, `out?` | パスワード保護コピーを出力（AES-256） |
| `pdf_metadata` | `path`, `set?`(object), `out?` | メタデータ読み取り（`set`+`out` で書き換えコピー出力） |
| `pdf_stamp` | `path`, `stamp`, `pages?`(all), `out?` | スタンプPDFの1ページ目を指定ページに重ね合わせ |

共通: `password?`（暗号化入力の復号用）, `out?`（未指定時は `active/shared/tmp/pdf-ops/<command>-<ts>.pdf`）, `timeout_ms?`, `export_as?`。`python` は `KYBERION_PYTHON || python3`。入力・出力パスは Kyberion project root 内に制限されます。

**前提パッケージ:**

```bash
python3 -m pip install pypdf            # 全 op に必要
python3 -m pip install cryptography     # pdf_encrypt（AES-256）や AES 暗号化PDFの復号に必要
# まとめて: python3 -m pip install "pypdf[crypto]"
```

例: `pdf-extract-range.json`（ページ抽出）, `pdf-merge.json`（結合）を参照。
