# DS-03: 文書エンジンのテーマ駆動化と日本語タイポグラフィ

> 優先度: P1 / 規模: M / 依存: DS-01(正準トークン)推奨 / 関連: IP-02(native エンジンの secure-io 化と作業が近接)

## 背景と課題

生成文書(PPTX/DOCX/PDF)の見た目の既定が「Office の初期値」のままで、日本語文書の生成品質・可搬性に穴がある。

- **PPTX テーマの既定が Office デフォルト**: `libs/core/src/native-pptx-engine/theme.ts:2-20` は accent1 `5B9BD5` 等の Office 標準パレットと Calibri をハードコード。**East-Asian(`<a:ea>`)タイプフェイスは既定で空**(`theme.ts:19`)で、theme pack が明示的に supply しない限り日本語フォント指定がない。`builders.ts:171` は latin と ea に同じフォントを適用。
- **PDF の日本語フォントが非埋め込み**: `native-pdf-engine/engine.ts:590-625` は非 ASCII 検出で `HeiseiKakuGo-W5`(Adobe-Japan1-6 CID 参照)へ切替えるが、**フォントを埋め込まない**ため、Adobe CJK フォントパックの無いビューア(多くの Windows 環境・ブラウザ内蔵ビューア)で表示が崩れ得る。顧客納品物としての可搬性リスク。
- **フォント既定が散在**: media-actuator に `'Inter'`/`'System-ui'`(`src/index.ts:423-424`)、`'Meiryo'` フォールバック(`:2433,2438`、`media-report-pipeline-helpers.ts:87,92`)が直書き。DOCX のフォントテーブルは Calibri/Times/`MS Gothic`(`native-docx-engine/engine.ts:571-573`)。日本語スタックの「正」が無い(DS-01 の正準トークンに定義予定)。
- 一方、theme pack → palette のブリッジ(`media-actuator/src/index.ts:1397-1417`)、テーマカタログ(`themes.json` 8 テーマ)、レイアウトプリセット等の**上位層は良くできている**。穴は「既定値」と「日本語」に集中している。

## ゴール(受入条件)

1. PPTX の既定テーマが Kyberion 正準トークン由来になり(`kyberion-standard`)、**`<a:ea>` に日本語フォントが常に設定される**(既定: Noto Sans JP 系または Yu Gothic、DS-01 の正準定義に従う)。
2. PDF エンジンが日本語サブセットフォントの**埋め込み**に対応し、ビューア非依存で日本語が表示される(埋め込みオン/オフはオプション、既定オン)。
3. フォント既定の直書きが正準トークン参照に置き換わり、`grep -rn "'Meiryo'\|'Inter'\|Calibri" libs/` の非テストヒットがトークン定義箇所のみになる。
4. 日本語文書のゴールデンテスト(PPTX/DOCX/PDF 各 1)が追加され、文字化け・フォント欠落の回帰を検出できる。

## 実装タスク

### Task 1: PPTX 既定テーマと ea フォント — `claude-sonnet-4`

1. `theme.ts` の `generateTheme()` を、正準トークン(DS-01 の `kyberion-standard`)を既定入力とする形に変更し、`<a:ea>` へ日本語フォントを必ず設定する(theme pack が supply した場合はそちら優先 — sbijsm の Meiryo UI 等の既存テナント pack の挙動を変えない)。
2. `builders.ts:171` の latin/ea 同一適用を、役割別(latin: heading/body、ea: 日本語スタック)に分離する。
3. 既存 `__tests__` + 新規: 日本語タイトルのスライドを生成し、theme XML に ea フォントが含まれることを検証。

### Task 2: PDF 日本語フォント埋め込み — `claude-sonnet-4`(調査込み)

1. 現行エンジンの構造(`engine.ts:590-625` の CID 参照方式)を確認し、TTF サブセット埋め込みの実装方式を選定する: (a) Noto Sans JP のサブセット化を自前実装(グリフ抽出は既存依存で可能か確認)、(b) 軽量な fontkit 系依存を 1 つ追加、(c) 使用文字の CIDFontType2 埋め込み。**調査結果(方式・依存・サイズ影響)を本文書に追記してから実装**する。
2. フォントファイルの取得・配置(ライセンス: Noto は SIL OFL で同梱可。`knowledge/public/design-patterns/fonts/` 等に配置し、パスは pathResolver 経由)。
3. 埋め込み有無のオプション(`embed_cjk_font: boolean`、既定 true)。ゴールデンテスト: 日本語 PDF のバイト内にフォントデータが存在し、既存 ASCII 文書のサイズが増えないこと。

#### 実装メモ

- 採用方式は `fontkit` + システム CJK フォント解決(`fc-match`)。
- PDF は日本語テキストがある場合にシステム CJK フォントを `CIDFontType2` として埋め込み、`embed_cjk_font` は既定 `true`。(現実装は glyph-id ベースの埋め込みで、サブセット化は未採用)
- PPTX / DOCX / PDF の回帰テストは追加済み。

### Task 3: フォント既定の一元化 — `claude-haiku`(DS-01 Task 2 完了後、置換表を添付して)

- `media-actuator/src/index.ts:423-424,2433,2438`、`media-report-pipeline-helpers.ts:87,92`、`native-docx-engine/engine.ts:571-573` のフォント直書きを正準トークン参照(または pack 経由の解決関数)に置換する。1 ファイルごとに該当テスト実行。

### Task 4: 日本語ゴールデンテスト — `claude-sonnet-4`

- `tests/golden/` の既存機構に、日本語見出し・本文・記号(①・㈱・長音)を含む PPTX/DOCX/PDF 生成のゴールデンを追加。検証は (a) 生成成功、(b) フォント指定の存在、(c) PDF はフォント埋め込みの存在。バイナリ完全一致は環境差で壊れやすいので**構造検証**にする。

## リスクと注意

- フォント埋め込みは成果物サイズを増やす(サブセットで数百KB想定)。サブセット化を必須とし、フルフォント埋め込みはしない。
- 既定テーマの変更は**既存テンプレート・テナント pack を上書きしない**こと(明示指定が常に優先)。既存の 8 テーマと sbijsm/sbiss の出力が変わらないことを検証してからマージする。
- IP-02(native エンジンの secure-io 化)と同じファイル群を触る。**実施順は IP-02 → DS-03** とし、コンフリクトを避ける。
