# Video Design System Integration Plan

## 目的

Hyperframes を用いた動画生成を、WebDesignSystem と同じ設計トークン、レイアウト変種、検証可能な契約で扱えるようにする。

## 作業チケット

| ID | 状態 | 内容 | 検証 |
|---|---|---|---|
| VDS-01 | Done | `video-content-brief` に `format`、`css_vars`、`layout_variant` を追加し、storyboard へ伝播する | `video-content-brief-contract.test.ts` |
| VDS-02 | Done | storyboard から narrated brief、composition ADF へ解像度、aspect ratio、design vars を伝播する | `narrated-video-brief-compiler.test.ts` |
| VDS-03 | Done | `vtuber-stage` で `split-left`、`split-right`、`focus-center`、`fullscreen-demo` を選択可能にする | `video-composition-compiler.test.ts` |
| VDS-04 | Done | `scene_id` をファイル名、DOM id、timeline key に使う前にサニタイズする | `video-composition-compiler.test.ts` |
| VDS-05 | Done | `avatar_assets` を scene content から bundle assets へ staging できるようにする | `video-composition-compiler.test.ts` |
| VDS-06 | Done | JSON schema を TypeScript contract に追従させ、actuator 入力で新フィールドを許可する | AJV schema test |
| VDS-07 | Next | 実際の WebDesignSystem pack / theme pack を外部 profile から選択する resolver を追加する | resolver unit test + pipeline fixture |
| VDS-08 | Done | PPTX 生成側で `css_vars` を theme palette に正規化し、動画と同じ WebDesignSystem 入力を利用できるようにする | media actuator protocol test |

## レビュー観点

- 入力由来の `scene_id` は raw のままファイルパス、HTML id、JS key に使わない。
- テーマ値は `design_system_ref.css_vars` で外から上書きできること。
- asset path は render bundle にコピーされてから HTML で相対参照されること。
- 16:9 と 9:16 の両方で `format` が contract 上表現できること。
- 新フィールドは TypeScript 型だけでなく JSON schema でも許可されること。
- PPTX は `--kb-bg-main`、`--kb-panel-bg`、`--kb-accent`、`--kb-warning`、`--kb-text-primary` を theme palette へ正規化すること。
