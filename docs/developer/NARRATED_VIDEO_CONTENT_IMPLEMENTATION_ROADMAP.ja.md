---
title: Narrated Video Content Implementation Roadmap
category: Developer Roadmap
tags: [video, content-brief, storyboard, design-system, hyperframes, roadmap]
last_updated: 2026-05-31
---

# Narrated Video Content Implementation Roadmap

この文書は、Kyberion のナレーション付き動画生成を「固定テンプレートの動画出力」から「content brief に基づく、動画向けデザインシステム駆動のコンテンツ生成」へ引き上げるための実装ロードマップである。

対象は、前段で audience / use case / message / constraints が決まっている前提で、それらの指示を受け取り、動画として意味のある構成・見せ方・レンダー成果物へ変換するプロセスである。

再開時は [チェックポイント文書](./NARRATED_VIDEO_CONTENT_IMPLEMENTATION_CHECKPOINT.ja.md) を先に読むと、現状の到達点と再実行コマンドを素早く復元できる。

## 1. 設計レビュー

現在の方向性は正しい。HyperFrames は deterministic HTML-to-video renderer として使い、公開契約は raw HTML ではなく Kyberion の governed contract に置くべきである。

ただし、現状の実装には 1 つ大きな欠落がある。`narrated-video-brief` が `script.hook / feature / cta` と `design_system` を直接持つだけなので、以下の判断材料を表現できない。

- 誰に向けた動画か
- 何を約束する動画か
- どの媒体・尺・視聴文脈に向けるか
- どの semantic role をどの順で見せるか
- 各 scene が proof / process / comparison / decision / CTA のどれなのか
- その semantic に応じて、動画向け design system がどの density / motion / caption / visual ratio を選ぶか

そのため、今のまま scene template を増やすと、動画ごとの見た目は増えるが、コンテンツの意味からデザインを決める構造にはならない。

必要な設計順序は次の通り。

1. `video-content-brief`: 何を誰にどう見せるかを固定する。
2. `video-storyboard`: brief を beat 単位の narrative / visual intent に展開する。
3. `video design tokens`: semantic role ごとの動画向け見せ方を解決する。
4. `narrated-video-brief`: narration と scene plan を生成する。
5. `video-composition-adf`: renderable な deterministic composition に落とす。
6. `hyperframes_cli`: HTML bundle を render し、音声を mux する。

## 2. 目標アーキテクチャ

```text
video-content-brief
  -> video-storyboard
  -> narrated-video-brief
  -> video-composition-adf
  -> video-composition bundle
  -> hyperframes render
  -> audio-muxed mp4
```

設計原則:

- content first: デザインは content type / audience / semantic role から決める。
- governed contracts: 外部入力は JSON schema で検証可能な contract に閉じる。
- deterministic rendering: 最終 composition は HyperFrames で再現可能に render する。
- design-system binding: theme token だけでなく、video 固有の density / motion / pacing を解決する。
- evidence lineage: brief / storyboard / narration / bundle / mp4 を mission evidence として残す。

## 3. Phase 0: 現状整理

目的: 現在の黒画面 fallback と固定 3 枚カード状態を抜け、HyperFrames render が動く土台を維持する。

実施済み:

- `hyperframes_cli` render が `127.0.0.1` bind で動くようにした。
- `video-render-backend` が事前 bind 判定で backend render を諦めないようにした。
- `kyberion-howto-narrated-demo` pipeline を `brief intake -> content plan -> render package` の説明へ寄せた。

残タスク:

- fallback の黒動画生成を成功扱いにしない。
- render 成否と fallback 成否を validation output で明確に分ける。
- 先頭 / 中盤 / 終盤 frame extract による visual sanity check を pipeline に入れる。

完了条件:

- `backend_render_backend=hyperframes_cli`
- `backend_rendered=true`
- final mp4 に video/audio stream が存在する
- 生成動画が黒一色 fallback ではない

## 4. Phase 1: Content Brief Contract

目的: 前段で決まった audience / use case / message / constraints を、動画制作の入力として明示する。

追加:

- `knowledge/product/schemas/video-content-brief.schema.json`
- `libs/core/video-content-brief-contract.ts`
- `libs/core/video-content-brief-compiler.ts`

想定 contract:

```json
{
  "kind": "video-content-brief",
  "version": "1.0.0",
  "title": "Kyberion How-To: Brief to Video",
  "audience": "operators and decision makers",
  "objective": "show how an approved message becomes a rendered video",
  "distribution_channel": "docs-demo",
  "content_type": "howto",
  "presentation_mode": "howto",
  "promise": "approved messaging can become reusable video evidence",
  "desired_takeaway": "Kyberion can govern content production from brief to render",
  "constraints": ["avoid generic product pitch", "show process", "keep deterministic"],
  "proof_points": [
    "brief is preserved",
    "storyboard is generated",
    "render bundle and mp4 are produced"
  ],
  "design_system_ref": {
    "system_id": "operator-ops",
    "theme": "kyberion-standard"
  }
}
```

実装手順:

1. schema を追加する。
2. TypeScript interface を追加する。
3. schema validation test を追加する。
4. existing demo pipeline の `write_content_brief` をこの schema に合わせる。

完了条件:

- invalid brief が schema で落ちる。
- demo pipeline が `video-content-brief` artifact を出す。
- brief から後続 contract へ必要な情報が失われない。

## 5. Phase 2: Storyboard Binding

目的: content brief を beat 単位の narrative / visual intent へ変換する。

既存:

- `knowledge/product/schemas/video-storyboard.schema.json`

拡張:

- `beats[].role`
- `beats[].semantic`
- `beats[].message`
- `beats[].visual_intent`
- `beats[].motion_intent`
- `beats[].caption_intent`
- `beats[].asset_requirements`
- `beats[].design_token_hints`

実装:

- `compileVideoContentBriefToStoryboard(brief)`
- `normalizeStoryboardTiming(storyboard, duration)`
- `selectStoryboardBeatsByContentType(content_type)`

初期 mapping:

| content_type | beats |
|---|---|
| `howto` | hook, process, proof, cta |
| `product-walkthrough` | hook, context, demo, proof, cta |
| `decision-support` | problem, evidence, recommendation, next-action |
| `docs-demo` | promise, steps, artifact, validation |

完了条件:

- `howto` brief から 3-5 beat の storyboard が生成される。
- 各 beat が `semantic` と `visual_intent` を持つ。
- storyboard は既存 `video-storyboard.schema.json` で検証できる。

## 6. Phase 3: Video Design Tokens

目的: 文書・スライド向け semantic token とは別に、動画向けの見せ方を semantic role ごとに決める。

変更:

- `knowledge/public/design-patterns/media-templates/semantic-render-tokens.json`
- `knowledge/public/design-patterns/media-templates/media-design-systems.json`

追加する `video` token:

```json
{
  "video": {
    "layout_family": "process-flow",
    "density": "medium",
    "motion_profile": "guided-step",
    "caption_style": "lower-third",
    "visual_ratio": "text-40-visual-60",
    "max_static_sec": 4,
    "safe_area": "wide-16x9",
    "beat_energy": "medium"
  }
}
```

semantic 初期セット:

- `hook`: immediate value promise
- `process`: ordered workflow
- `proof`: evidence / artifact / result
- `demo`: screen or command sequence
- `comparison`: before / after or alternative
- `decision`: recommended next step
- `cta`: final action

完了条件:

- `semantic=process` が process-flow layout を解決できる。
- `semantic=proof` が artifact/evidence layout を解決できる。
- `semantic=cta` が短い final action layout を解決できる。
- token が `narrated-video-brief` または `video-composition-adf.scene.content` に反映される。

## 7. Phase 3.5: Presentation Mode / Stage Design

目的: `howto / promo / vtuber` のような presentation mode を、content brief から render まで一貫して反映させる。

考え方:

- `content_type` は「何を作るか」を示す。
- `presentation_mode` は「どう見せるか」を示す。
- `design_system_ref.layout_family` は mode に応じたレイアウトの初期値を示す。
- `video-composition-template-registry` は mode ごとのテンプレートを受け入れる。

初期マッピング:

| presentation_mode | 目的 | 既定 layout | 主テンプレート |
|---|---|---|---|
| `howto` | 手順・検証・再現性を見せる | `process-flow` | `howto-guide` |
| `promo` | 価値・訴求・CTA を強く見せる | `promo-spot` | `promo-spot` |
| `vtuber` | 人格・対話・ライブ感を見せる | `vtuber-stage` | `vtuber-stage` |

完了条件:

- `video-content-brief` に `presentation_mode` を付けられる。
- `presentation_mode` が storyboard と render bundle に残る。
- `promo` と `vtuber` で見た目のレイアウトが明確に変わる。
- どの mode を使ったかが bundle index と evidence から追跡できる。

## 8. Phase 4: Compiler Split

目的: `narrated-video-brief-compiler` の固定 3 scene 生成をやめ、storyboard と design tokens から scene を生成する。

変更対象:

- `libs/core/narrated-video-brief-compiler.ts`
- `libs/core/video-composition-contract.ts`
- `libs/core/video-composition-compiler.ts`
- `libs/core/index.ts`

実装:

- `compileVideoStoryboardToNarratedVideoBrief(storyboard, options)`
- `compileNarratedVideoBriefToCompositionADF(brief)` に storyboard-aware path を追加
- `selectTemplateForBeat(beat, designTokens)`
- `buildSceneContentFromBeat(beat, designTokens)`

互換性:

- 既存の `script.hook / feature / cta` だけの brief は従来通り 3 scene に fallback する。
- 新しい `storyboard` 入力がある場合は beats から scene を生成する。

完了条件:

- 旧 brief のテストが通る。
- storyboard 付き brief のテストが通る。
- `semantic=process` の beat が process diagram scene になる。
- `semantic=proof` の beat が proof/evidence scene になる。

## 9. Phase 5: Template Rendering

目的: template 内の hardcoded 表示をなくし、scene content から描画できるようにする。

変更対象:

- `libs/core/video-composition-compiler.ts`
- `knowledge/product/governance/video-composition-template-registry.json`

追加 content fields:

- `visual_steps`
- `evidence_items`
- `artifact_refs`
- `caption`
- `callout`
- `screen_ref`
- `cta`

template 方針:

| template | role | content |
|---|---|---|
| `basic-title-card` | hook | headline, body, caption |
| `howto-guide` | process/demo | headline, body, visual_steps |
| `split-highlight` | proof/evidence | headline, body, visual_steps/evidence_items/screen_ref |
| `promo-spot` | hook/value/proof/cta | headline, body, value_points, social_proof |
| `vtuber-stage` | hook/persona/demo/cta | headline, body, chat_messages, stage_notes |
| `logo-outro` | cta/outro | headline, body, cta |

完了条件:

- `Brief intake / Content plan / Render package` の文言が template hardcode ではなく `visual_steps` から出る。
- process / proof / cta の最低 3 パターンが snapshot または HTML content test で保護される。

## 10. Phase 6: Actuator Actions

目的: pipeline から content brief を直接渡せるようにする。

変更対象:

- `libs/actuators/video-composition-actuator/src/index.ts`
- `schemas/video-composition-action.schema.json`
- `libs/actuators/video-composition-actuator/src/index.test.ts`

追加 action:

- `compile_video_content_brief`
- `create_narrated_video_from_content_brief`

戻り値:

- `video_content_brief`
- `video_storyboard`
- `narrated_video_brief`
- `video_composition_adf`
- `execution`

完了条件:

- action schema validation が通る。
- actuator test で content brief から `video-composition-adf` まで到達する。
- `await_completion=true` で final render artifact まで返せる。

## 11. Phase 7: Demo Pipeline Refresh

目的: `kyberion-howto-narrated-demo` を、新アーキテクチャの end-to-end proof にする。

変更対象:

- `pipelines/kyberion-howto-narrated-demo.json`
- `docs/PRODUCTIZATION_ROADMAP.md`
- optional: `docs/demos/`

新しい pipeline:

```text
preflight
  -> write video-content-brief
  -> compile_video_content_brief
  -> generate_voice
  -> create_narrated_video_from_content_brief
  -> validate streams
  -> extract frames
  -> write summary
```

完了条件:

- evidence に以下が残る:
  - `video-content-brief.json`
  - `video-storyboard.json`
  - `narrated-video-brief.json`
  - `video-composition-adf.json`
  - `render-plan.json`
  - final mp4
- final mp4 が黒画面 fallback ではない。
- README/docs demo に出せる説明単位になっている。

## 12. Phase 8: Quality Gates

目的: 動画として破綻した成果物を成功扱いしない。

追加 checks:

- `ffprobe` で video/audio stream を確認
- frame extract で先頭 / 中盤 / 終盤の png を保存
- `blackframe` filter または簡易 luminance check で黒一色を検出
- narration duration と video duration の差分を確認
- generated HTML に `data-composition-id`, duration, dimensions があることを確認
- `max_static_sec` を超える場合は warning

完了条件:

- fallback 黒動画は validation で失敗する。
- render failure と content quality failure が別の error category になる。
- pipeline summary に次の runnable command が出る。

## 13. GPT 5.4 実装タスク分解

GPT 5.4 に渡す作業順は以下。

1. `video-content-brief` schema と TypeScript contract を追加する。
2. `video-storyboard.schema.json` を semantic / visual / motion intent 対応に拡張する。
3. `semantic-render-tokens.json` と `media-design-systems.json` に `video` token を追加する。
4. `video-content-brief-compiler.ts` を追加し、brief から storyboard を生成する。
5. `narrated-video-brief-compiler.ts` を storyboard-aware にする。
6. `video-composition-compiler.ts` を `visual_steps` / `evidence_items` / `cta` から描画するように変える。
7. `video-composition-actuator` に `compile_video_content_brief` と `create_narrated_video_from_content_brief` を追加する。
8. `kyberion-howto-narrated-demo.json` を content brief 起点に更新する。
9. unit tests と pipeline e2e を通す。
10. roadmap と demo summary を更新する。

## 13. 検証コマンド

```bash
pnpm --filter @agent/core build
pnpm exec vitest run \
  libs/core/narrated-video-brief-compiler.test.ts \
  libs/core/video-composition-compiler.test.ts \
  libs/actuators/video-composition-actuator/src/index.test.ts
pnpm pipeline --input pipelines/kyberion-howto-narrated-demo.json
ffprobe -hide_banner active/missions/confidential/MSN-KYBERION-HOWTO-VIDEO/evidence/kyberion-howto-demo.mp4
```

## 14. 受入条件

- content brief から storyboard / narrated brief / composition ADF / render bundle / final mp4 が生成される。
- design は fixed template ではなく semantic role と video design tokens から選ばれる。
- `howto` 動画は `hook -> process -> proof -> cta` の narrative を持つ。
- process diagram は hardcode ではなく scene content から描画される。
- final mp4 は HyperFrames backend render により生成され、video/audio stream を持つ。
- failure 時は「render failure」「audio mux failure」「content quality failure」を区別できる。

## 15. Non-goals

- YouTube への public publish 自動化はこの roadmap の範囲外。render と publish package 作成までを対象にする。
- personal voice cloning の実装は範囲外。ただし narration artifact の contract は維持する。
- raw HTML をユーザー向け contract にしない。HTML は compiler output として扱う。
