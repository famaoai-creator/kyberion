# LLM/決定論 境界の横断監査(2026-07-13)

> 契機: agy 縦型ショートと pptx の「毎回同じ見た目」問題(#545)。同型の境界設計不全が他に無いかをクリエイティブ生成チェーン全体で監査した。

## 設計原則(再確認)

- **決定論(compiler/renderer zone)**: レイアウト解決・レンダリング・検証・ガバナンス。再現性と統制のため LLM を入れない。
- **LLM(llm_zone)**: 意味内容の起草と、**統制カタログからの選択**。生成させる場合は必ずスキーマ検証 + 縮退。選択 > 生成(縮退しにくく、統制外の出力が構造的に不可能)。
- 接続の型: `core の選択/起草関数(generate 注入可・失敗時は既定へ縮退)` → `actuator op へ自動配線` or `pipeline の reasoning ステップ`。

## 健全な実例(維持)

| 箇所                                    | 状態                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| media-generation `generate_image/music` | PromptStylePack 自動注入(`no_style_pack` でオプトアウト)— テーマ→プロンプトの決定論射影 |
| draft-refine(worker / task-session)     | 高リスク成果物のみ 1 パス改稿、ルーブリックは決定論                                     |
| best-of-N / mission staffing            | 発動条件は決定論、判断は LLM、実績データで接地                                          |
| run_pipeline `reasoning:*` op           | pipeline に意味論ステップを挟む正規手段として存在                                       |
| governance 系全般                       | 決定論で正しい(LLM を入れるべきでない)                                                  |

## 発見した同型問題(固定既定への転落)

1. **pipeline 層のテーマ/パターン既定**(影響: 中〜大): `marketing-content.json` / `generate-masterclass-pptx.json` / `contract-review.json` はいずれも reasoning ステップ 0 で、`theme: default 'kyberion-standard'`、`pattern: default 'corporate-grid'` に落ちる。#545 の deck 選択は `document_outline_from_brief` 経由のみ有効で、`apply_theme` 直呼びの pipeline は素通り。
2. **スライド本文の LLM 起草面が未実装**(影響: 大): `media-document-helpers` の llm_zone 宣言 `draft_body_content` に実装が存在しない(2026-07-12 確認)。brief に本文が無いと、デッキはセクション見出し+薄い定型文になる。宣言だけの llm_zone は #542 系統の「宣言と実装の乖離」。
3. **narrated video の legacy 経路**(影響: 中): storyboard 無しで `buildLegacyScenes` に入ると `brief.script.hook/cta` のテンプレ流し込み。storyboard 起草(LLM)を飛ばした呼び出しは動画も固定文になる。
4. **diagram の fallback テーマ / layout_template_id**(影響: 小): 同じ既定落ちパターン。

## 推奨(優先順)

- **A(小・即効)**: `pipelines/fragments/design-direction.json` を新設し、`apply_theme` の前段に「story からテーマ/パターンを選択する」ステップ(#545 の `selectDeckTheme` / `generateVideoVisualDirection` を op 化)を挟む。creative pipeline 3本へ適用。
- **B(大)**: `draft_body_content` の実体化 — brief.sections に本文が無い場合の reasoning 起草(DS-03 の JP タイポ・MO-07 の draft-refine と接続して設計)。
- **C(小)**: `buildLegacyScenes` 突入時に警告 + 「reasoning で最小 storyboard を起草してから」の導線を narrated アクションに追加。

## 逆パターン(LLM に任せすぎ)の検査結果

大物は未検出。明確化質問・ヘルプ・ゲート評価などオペレータ契約面は決定論 + カタログで正しく固定されている。
