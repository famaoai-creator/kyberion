# E2E-02: クリエイティブ統合 — 動画・パワポ・音楽・MV・Web を1つのデザインシステムで流す

> 優先度: **P0**(中核ユースケース第2弾) / 規模: M〜L(タスク分割済み) / 依存: DS-01(完了)。DS-02/DS-04 の未了分を本計画の Task 2/3 が具体化して引き取る
> 実装担当モデル: 各タスクに明記。**gpt-5.4-mini クラス単独で実装可能な粒度**(README §2.1 の読み替え表に従う)
> 調査日: 2026-07-05(実コード検証済み)

## 0. 実装エージェントへ(E2E-01 と同じ規約)

- Task 内の手順を上から順に。変更前に対象ファイルを読み、行番号ずれは現状を正とする。
- ファイル I/O は `@agent/core`(secure-io)経由のみ。各 Task 末尾の「検証」全通過 + `pnpm lint && pnpm typecheck` で完了。
- **本計画の合言葉は「デザインの解決は1回だけ」**: どの成果物も、生成の冒頭で単一の resolver から解決済みデザインを受け取り、以降ハードコード値を一切書かない。

## 1. 目指す流れ

```
1つの brief(何を・誰に・どのトーンで)
  + 1つのデザインシステム(brand tokens → tenant 上書き)
  ────────────────────────────────────────────
  → デッキ(PPTX) / 文書(docx/pdf) / 動画 / 音楽 / MV / Web(LP・4サーフェス)
    が同一パレット・同一タイポ・同一トーンで一括生成される
```

## 2. 調査結果 — 生成部品は揃っている。分裂しているのは「デザインの正本」と「束ねる流れ」

**動く部品(検証済み)**:

| 成果物 | 部品 | 場所 |
|---|---|---|
| デッキ/文書/表計算 | native-pptx/docx/xlsx/pdf エンジン + proposal storyline + document briefs + `resolveThemeColors()` PPTX ブリッジ | `libs/core/src/native-*-engine/`、`media-actuator/src/index.ts:1397-1417` |
| 画像/動画/音楽 | `generate_image` / `generate_video` / `generate_music`(music_adf 対応)/ `run_workflow`(ComfyUI) | `media-generation-actuator`(manifest 10 ops) |
| ナレーション動画 | `compile_narrated_video_brief` → `create_narrated_video_from_content_brief` → `verify_rendered_video_artifact` + 合成 job 機構 | `video-composition-actuator`(manifest 9 ops)、`pipelines/kyberion-vtuber-narrated-demo*.json` |
| Web | brand-tokens → `generate_design_tokens.ts` → 4 サーフェス CSS + `WebThemePack` / `WebDesignSystemPack` 型 | `knowledge/public/design-patterns/brand-tokens/kyberion.json`、`libs/core/web-design-system.ts` |
| テナント上書き | `tenant-design-resolver` + `knowledge/confidential/<slug>/design/tenant-override.json` + DESIGN.md 取込カタログ | `@agent/core/tenant-design-resolver`、`design-md-catalog/` |

**切れている継ぎ目(ギャップ)**:

- **G1: デザイン正本が分裂し、既に食い違っている**。`media-templates/themes.json` と `media-templates/themes/themes.json` は**両方生成対象なのに内容が DIVERGED**(2026-07-05 実測)。media-actuator は両系統 + `active/shared/runtime/...` の3層を読む(`index.ts:2605-2610`)。さらに `media-design-systems.json` / `semantic-render-tokens.json` / `excel-sheet-themes.json` / brand-tokens が並立し、**「この成果物のデザインはどこで決まるか」に単一の答えが無い**。
- **G2: テナント/デザイン解決が面ごとにバラバラ**。Web は `tenant-design-resolver`(消費者は chronos の route 1箇所のみ)、PPTX は `resolveThemeColors` + tenant-override.json、**動画は常に既定トークン固定**(VDS-07 未実装 — DS-02:11 に明記)、画像/音楽は解決自体が無い。
- **G3: 動画シーンテンプレート内部の色・フォントがハードコード**(DS-04 未着手)。トークンを差し替えてもシーンの見た目が変わらない。
- **G4: 生成系プロンプトにブランドが乗らない**。`generate_image/video/music` は PROMPT_BASED(`media-generation-action-helpers.ts:38`)だが、パレット hex・トーン語彙・タイポ指針・負例(避けるべき表現)を**プロンプトへ注入する仕組みが無い**。毎回「それっぽいが揃わない」出力になる根本原因。
- **G5: MV(音楽×映像)を束ねる工程が無い**。`generate_music`(music_adf)と映像合成は独立していて、**音声トラックを映像に mux する op・歌詞/字幕同期・MV パイプラインが存在しない**(video-composition に audio/bgm 系の処理なし — grep 実測)。
- **G6: 「1 brief → 複数成果物」のキャンペーン統合パイプラインが無い**。61 本の pipelines 中、メディア系は narrated-demo 系のみ。デッキ・動画・Web を同時に、同一デザインで出す流れは毎回手作業。

## 3. ゴール(受入条件)

1. `resolveCreativeDesign({ tenantSlug?, surface })` が唯一の解決入口になり、`surface: 'web'|'pptx'|'doc'|'video'|'prompt'` ごとの projection(WebThemePack / media theme / video css_vars / prompt style pack)を返す。**全生成面がこれを使う**。
2. `themes/themes.json` の重複が解消され、正本ドリフトは `check:catalogs` が検知する。
3. 動画がテナントブランドで出る(VDS-07 解消)。シーンテンプレはトークン参照のみ(DS-04 解消)。
4. `generate_image/video/music` に style pack が自動注入され、成果物間でパレット・トーンが揃う。
5. `pnpm pipeline --input pipelines/mv-compose.json` 1本で、music_adf → 楽曲 → シーン映像 → 音声 mux → 字幕 → 検証済み MV mp4 が出る。
6. `pnpm pipeline --input pipelines/campaign-suite.json --context '{"brief_path":"..."}'` 1本で、同一 brief からデッキ+文書+イントロ動画+Web LP セクション(+任意で MV)が同一デザインで一括生成される。
7. E2E テスト: 全成果物のメタデータから抽出した primary/accent hex が一致することを機械検証(stub backend・ComfyUI 不要のモック経路)。

## 4. 実装タスク

### Task 1: デザイン解決の単一入口 `resolveCreativeDesign` — `gpt-5.4-mini`

1. `libs/core/creative-design-resolver.ts` を新設:
   ```ts
   type CreativeSurface = 'web' | 'pptx' | 'doc' | 'xlsx' | 'video' | 'prompt';
   interface ResolvedCreativeDesign {
     source: 'brand-default' | 'tenant-override' | 'design-md';
     tenant_slug?: string;
     colors: { primary; secondary; accent; background; text; warning };  // hex
     fonts: { sans; mono };
     // surface 別 projection(下記 2.)
     projection: WebThemePack | MediaThemeRecord | VideoCssVars | PromptStylePack;
   }
   function resolveCreativeDesign(input: { tenantSlug?: string; surface: CreativeSurface }): ResolvedCreativeDesign
   ```
2. 解決順序(既存資産の合成のみ。新しい形式を発明しない):
   1. `brand-tokens/kyberion.json` を読み基礎 colors/fonts とする(light を既定、video/prompt は dark を既定)
   2. `tenantSlug` があれば既存 `tenant-design-resolver` の解決結果で上書き
   3. surface projection:
      - `web` → 既存 `WebThemePack` 形式(`web-design-system.ts:1`)
      - `pptx`/`doc`/`xlsx` → `themes.json` の `kyberion-standard`/`kyberion-sovereign` と同形式のレコードを colors/fonts から組み立て(media-actuator が今読んでいる形式。`index.ts:2600-2650` 付近の theme 解決を読んで一致させる)
      - `video` → VDS の css_vars 形式(`--kb-*` 変数マップ。`VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN` の VDS-02 が定義した形式を踏襲)
      - `prompt` → Task 4 の `PromptStylePack`
3. `@agent/core` から export。unit test: brand既定 / tenant上書き / surface別 projection の3系(tenant-override は media テストの fixture パターンを流用)。
4. **検証**: `pnpm exec vitest run libs/core/creative-design-resolver.test.ts`。

### Task 2: themes 二重管理の解消 + 動画のテナント適用(VDS-07)— `gpt-5.4-mini`

1. **themes 一本化**: 正本を `media-templates/themes.json` に確定。`themes/themes.json` は削除し、media-actuator の読み込み3層(`index.ts:2605-2610`)から directoryPath 側の重複読みを除去(runtime 上書き層 `active/shared/runtime/...` は残す)。`scripts/generate_design_tokens.ts` の `THEMES_JSON_NESTED_PATH` 更新も削除。
2. **ドリフト検査**: `scripts/check_catalog_integrity.ts` に「brand-tokens の light/dark colors と themes.json の kyberion-standard/sovereign が一致」検査を追加(不一致で violation。fix 文言=`pnpm tsx scripts/generate_design_tokens.ts`)。
3. **VDS-07**: 動画の css_vars 供給箇所(`libs/core/` の video 系で `--kb-` 変数を組む箇所を grep で特定。VDS-02 の配管)を `resolveCreativeDesign({ tenantSlug, surface: 'video' })` 経由に差し替え。tenantSlug はミッション state(`tenant_slug`)から取り、無ければ brand 既定(現行と同じ見た目=後方互換)。
4. **検証**: 既存 media-actuator テスト全緑 / `pnpm run check:catalogs` / tenant-override fixture を置いた状態で video css_vars に override の hex が出る unit test。

### Task 3: 動画シーンテンプレートのトークン化(DS-04 の実装版)— `gpt-5.4-mini`

1. video-composition-actuator のシーンテンプレート定義(`list_video_composition_templates` が返す実体ファイルを読んで特定)内のリテラル色・フォントを `{{--kb-primary}}` 等のトークン参照に置換。
2. レンダリング直前に Task 1 の video projection で置換するヘルパー(`applyVideoDesignTokens(template, resolved)`)を1箇所に実装。**テンプレートを増やすときはトークン以外の色を書かない**旨をテンプレートファイル先頭コメントに明記。
3. **検証**: 既定デザインでのレンダー結果が現行と一致(既存の `verify_rendered_video_artifact` テストが緑のまま)/ ダミー override で色が変わる unit test。

### Task 4: 生成プロンプトへの style pack 自動注入 — `gpt-5.4-mini`

1. Task 1 の `PromptStylePack` を定義:
   ```ts
   interface PromptStylePack {
     palette_hex: string[];            // primary/secondary/accent/background
     tone_words: string[];             // 例: ['clean','modern','tech','japanese-minimal']
     typography_hint: string;          // 例: 'Inter / Noto Sans JP 系のジオメトリックサンセリフ'
     avoid: string[];                  // 例: ['clip-art','watermark','off-brand colors']
     music?: { mood: string; bpm_range?: [number, number]; instrumentation_hint?: string };
   }
   ```
   tone_words / music は `media-design-systems.json` に `style_pack` セクションとして追記し(スキーマも更新)、色は brand/tenant から自動導出。
2. `media-generation-action-helpers.ts:38` の PROMPT_BASED 経路で、dispatch 直前に `resolveCreativeDesign({ surface: 'prompt', tenantSlug })` を呼び、プロンプト末尾に定型ブロック(`Style: palette=#0A192F,#00F2FF…; tone=…; avoid=…`)を追記する。`params.no_style_pack: true` でオプトアウト可(後方互換)。
3. `generate_music` は `music.mood/bpm` を music_adf に無い場合の既定として注入。
4. **検証**: unit test で「プロンプトに palette hex が含まれる」「no_style_pack で含まれない」。既存 media-generation テスト緑。

### Task 5: MV 組立パイプライン — `claude-sonnet-4` 相当(mux の新 op のみ判断が要る。残りは mini)

1. video-composition-actuator に `mux_audio_track` op を追加(±60行): 入力 `{ video_path, audio_path, output_path, offset_ms? }`、実装は既存レンダリング job が使う ffmpeg 呼び出し機構(`video-render-backend` / 合成 job の spawn 経路を流用。ffmpeg 不在は AC-01 の prerequisites で宣言: `binaries: ['ffmpeg']` + install hint)。manifest / スキーマ / `sync_component_inventory` 再生成も忘れない。
2. `pipelines/mv-compose.json` を新設。context: `music_adf_path`, `scene_brief_path`, `tenant_slug?`。steps:
   1. media-generation `generate_music`(music_adf → `active/.../mv/track.wav`。ComfyUI 不在時は preflight で止める — AC-01 gate に載せる)
   2. video-composition `compile_video_content_brief` → `create_narrated_video_from_content_brief`(ナレーション無し設定で映像のみ。style は Task 2/3 によりテナント適用済み)
   3. `mux_audio_track`(映像+楽曲)
   4. 歌詞があれば字幕: 既存ナレーション字幕機構(narrated 系が字幕を焼く経路)に `lyrics_path` を渡す。無理なら本タスクでは srt サイドカー出力に留める(judgment: 焼き込みは追わない)
   5. `verify_rendered_video_artifact`
3. **検証**: ffmpeg + fixture 音源(1秒 wav を `tests/fixtures/` に生成)で `mux_audio_track` unit test / mv-compose を dry-run 相当(生成系はモック)で構造検証。

### Task 6: キャンペーン統合パイプライン — `gpt-5.4-mini`(既存 op の連結のみ)

1. `schemas/campaign-brief.schema.json` を新設: `{ title, audience, tenant_slug?, tone?, deliverables: ('deck'|'doc'|'intro_video'|'web_lp'|'mv')[], key_messages[], sections[] }`。
2. `pipelines/campaign-suite.json` を新設。brief を読み、`core:parallel_foreach` で選択された deliverable を並列生成:
   - `deck` → media-actuator の proposal storyline 経路(brief.sections → storyline adf → PPTX)
   - `doc` → `document_report_design_from_brief`
   - `intro_video` → video-composition `create_narrated_intro_movie`
   - `web_lp` → `web-design-system.ts` の `WebDesignSystemPack` から LP セクション HTML を出す既存機構(無ければ pack JSON + セクション markdown の出力に留める — judgment: HTML レンダラ新設はしない)
   - `mv` → Task 5 の mv-compose を `core:run_pipeline`(サブパイプライン呼び出し。既存に無ければ `system:exec` で `run_pipeline.js --input` を呼ぶ)
   全成果物は `active/missions/<id>/evidence/campaign/<deliverable>/` に集約し、最後に manifest(`campaign-manifest.json`: 各成果物のパス + 使用した design source/hex)を書く。
3. **検証**: deliverables=['deck','doc'] の最小構成で実走(stub backend)し、manifest に両成果物と同一の primary hex が記録されること。

### Task 7: 「揃っている」ことの機械検証(E2E テスト)— `gpt-5.4-mini`

1. `tests/creative-suite-consistency.test.ts` を新設(stub・生成系モック):
   1. ダミー tenant-override(primary=#123456)を fixture 配置
   2. `resolveCreativeDesign` を web/pptx/video/prompt の4面で呼び、**全 projection の primary が #123456 に一致**することをアサート(G1/G2 の回帰網)
   3. campaign-suite(deck+doc)を実行し、campaign-manifest.json の hex が同値であること
   4. prompt style pack 注入済みプロンプトに #123456 が含まれること
2. **検証**: 本テスト + 既存 media/video/web 系テスト全緑。

## 5. リスクと注意

- **見た目の後方互換**: Task 2/3 は「tenant 未指定なら現行と同一出力」を必ず保つ(既存 golden/スナップショットテストを先に緑で確認してから差し替える)。
- ComfyUI / ffmpeg はネットワーク・環境依存。**パイプラインに直接前提を埋め込まず AC-01 の manifest prerequisites で宣言**し、実行前ゲートに止めさせる(E2E-01 Task 1 の preflight 思想と同じ)。
- style pack のプロンプト注入は生成品質を変える。`no_style_pack` オプトアウトを必ず残し、注入文言は `media-design-systems.json` 側で編集可能にする(コード埋め込み禁止)。
- 音楽・映像の権利表記/出所メタデータは campaign-manifest に `generated_by`(モデル/ワークフロー名)を必ず記録する。
- DS-02/DS-04/DS-05 の既存計画と重複する箇所は本計画が「実装の具体化」であり、完了時に両計画のステータスも更新すること。

## 6. 実施順序

Task 1(resolver)→ Task 2(正本一本化+VDS-07)→ {Task 3, Task 4 並行} → Task 5(MV)→ Task 6(campaign)→ Task 7(整合テスト)。
Task 1〜4 だけでも「全成果物のデザインが揃う」という体感価値が出る。Task 5/6 は流れの統合。
