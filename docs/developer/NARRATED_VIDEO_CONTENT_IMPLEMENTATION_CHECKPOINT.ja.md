---
title: Narrated Video Content Implementation Checkpoint
category: Developer Checkpoint
tags: [video, content-brief, storyboard, design-system, hyperframes, checkpoint, resume]
last_updated: 2026-05-31
---

# Narrated Video Content Implementation Checkpoint

この文書は、ナレーション付き動画コンテンツの実装を途中から再開するための最短導線である。

## 現在の到達点

- `video-content-brief` から `video-storyboard` を生成できる。
- `presentation_mode` は `howto / promo / vtuber` をサポートする。
- `narrated-video-brief` と `video-composition-adf` は mode-aware で生成される。
- `howto` デモは HyperFrames で実レンダリング済みで、音声付き mp4 が生成できる。
- `promo` / `vtuber` の demo pipeline を追加済みで、各モードの実行入口がある。
- `video-composition-compiler` は `howto-guide / promo-spot / vtuber-stage` を描画できる。

## 既知の再開ポイント

- sandbox 内では `blackdetect` が厳しめに反応するため、最終確認は sandbox 外で実行する。
- `video-composition-compiler.ts` と `video-composition-compiler.js` は必ず同時に更新する。
- `video-content-brief` を追加する場合は、`narrated-video-brief` と pipeline input まで一気通貫で更新する。

## 再開手順

1. `pnpm build`
2. `pnpm exec vitest run libs/core/video-content-brief-contract.test.ts libs/core/narrated-video-brief-compiler.test.ts libs/core/video-composition-compiler.test.ts libs/actuators/video-composition-actuator/src/index.test.ts`
3. `pnpm pipeline --input pipelines/kyberion-howto-narrated-demo.json`
4. sandbox 側で blackdetect が落ちる場合は、sandbox 外で同じ pipeline を再実行する
5. `ffprobe` と frame extract で mp4 を確認する

## 参照先

- [実装ロードマップ](./NARRATED_VIDEO_CONTENT_IMPLEMENTATION_ROADMAP.ja.md)
- [開発者向け README](./README.md)
- [How-to 手順書](../../knowledge/public/procedures/media/create-narrated-intro-movie.md)

## 次の拡張候補

- `promo` / `vtuber` の実行結果を個別にレンダリングして、見た目と音声を確認する
- `presentation_mode` ごとの motion / density / typography をさらに細かく分ける
- mission の distill を実行して、今回の設計変更を knowledge に落とす
