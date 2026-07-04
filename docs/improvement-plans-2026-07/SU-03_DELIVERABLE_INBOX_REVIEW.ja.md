# SU-03: 成果物インボックスとレビュー・反復

> 優先度: P1 / 規模: M / 依存: IL-04(完了突合)、MO-07(品質・再生成) / 関連: USER_EXPERIENCE_CONTRACT の Delivery-Summary shape、DS-03(文書生成)
>
> **なぜ重要か**: 「成果物ができた → 承認する / 差し戻す / 修正を頼む」はオペレータの中核ジョブ。現状は disk 上のファイルを開くだけで、判定・コメント・反復のループが無い。製品の出口体験。

## 背景と課題

- **成果物は「開く」だけ**: openable なのは FocusedOperatorView のミッション別アセット一覧のみ(`FocusedOperatorView.tsx:703-716`、`/api/mission-asset` は pptx/docx/xlsx/pdf/画像対応 `mission-asset/route.ts:57-62`)。それ以外の場所では成果物は**ファイル名文字列**にすぎない(`MissionIntelligence.tsx:2690,2714`)。`KbArtifactTile` は cursor-pointer だが**何も開けない**(`A2UIComponentLibrary.tsx:469-483`)。
- **判定・反復ができない**: accept/reject/request-changes の verdict なし、コメントなし、再生成/iterate ループなし。USER_EXPERIENCE_CONTRACT の Delivery-Summary(産出成果物 + レビュー次アクション、`:83-95`)は操作面を持たない。
- **横断インボックス/ギャラリーが無い**: 「Kyberion が私のために作ったもの全部を見せて」ができない。成果物はミッション別のフォーカスビュー内にしか到達できない。in-app プレビューも download/preview トグルも版管理も無い。operator-surface は成果物を配信すらせず evidence ファイル名だけ(`operator-surface/app/missions/[id]/page.tsx:32-48`)。

## ゴール(受入条件)

1. **成果物インボックス/ギャラリー**(横断)が新設され、全ミッションの成果物を一覧・検索・プレビューできる。
2. **成果物レビュー**: 各成果物に accept / reject / request-changes の verdict とコメントを付けられ、判定が IL-04 の完了突合・監査に接続。
3. **反復**: request-changes がコメント付きで**再生成(MO-07 の draft-refine/quality-gated redo)をトリガ**でき、版が管理される(v1/v2…)。
4. **in-app プレビュー**: pptx/docx/pdf/画像がアプリ内でプレビューでき(ブラウザ inline 依存を脱却できる範囲で)、download/preview を選べる。
5. `kb-artifact-tile` が実際に開ける/操作できるよう配線。

## 実装タスク

### Task 1: 成果物インボックス API とデータ源 — `claude-sonnet-4`

1. 全ミッションの成果物を集約する API(`app/api/deliverables`): mission state のアセット参照 + `/api/mission-asset` を横断集約し、kind/mission/日付/tenant でフィルタ・検索可能に。相関 ID(IL-02)で intent と紐付け。
2. tenant 隔離(confidential 成果物は当該文脈のみ)。
3. テスト: 集約・フィルタ・tenant 分離。

### Task 2: インボックス/ギャラリー UI と kb-artifact-tile 配線 — `claude-sonnet-4`

1. 成果物ギャラリー画面(SU-01 のオペレータホームからリンク): サムネイル/一覧、検索、プレビュー。`KbArtifactTile`(`A2UIComponentLibrary.tsx:469-483`)に open/preview ハンドラを配線。
2. in-app プレビュー: 画像はネイティブ、pdf はブラウザ埋め込み、pptx/docx は(可能なら)サムネイル or ダウンロード誘導。download/preview トグル。
3. テスト: 各 kind のプレビュー/ダウンロード。

### Task 3: レビュー verdict と反復 — `claude-sonnet-4`

1. 各成果物に accept/reject/request-changes + コメントを付ける UI と API(`deliverable_review`)。verdict は IL-04 の完了突合(satisfied/gaps)と監査に接続。
2. request-changes は、コメントを新しいタスク/goal 差分として MO-07 の再生成(draft-refine / quality-gated redo)に渡し、成果物の**版**(v2)を作る。前版との差分を表示。
3. reject は完了を取り消し、ミッションを validating/rework(MO-02)に戻す。
4. テスト: accept→完了確定、request-changes→再生成で v2、reject→rework。

### Task 4: Delivery-Summary shape の操作面 — `claude-haiku`

- 完了時(IL-04 のクロージング)に Delivery-Summary(産出成果物 + verdict ボタン + 次アクション)を提示する画面/ブロックを追加し、USER_EXPERIENCE_CONTRACT の shape を操作可能にする。UX-01/05 準拠。

## リスクと注意

- in-app の pptx/docx プレビューは重い/依存増になりがち。**まずダウンロード + 画像/PDF プレビュー**を確実にし、Office 形式のリッチプレビューは「次の一手」に回す(依存を増やさない)。
- 版管理は成果物ストレージを増やす。KM-01 の janitor に古い版の TTL/世代保持を登録。
- confidential 成果物のプレビュー/ギャラリー表示は tier 境界を厳守(SU-01/DS-02 の tenant 文脈と整合)。
