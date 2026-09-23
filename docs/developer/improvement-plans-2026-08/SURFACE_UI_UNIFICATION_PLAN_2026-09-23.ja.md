---
title: サーフェス UI 統一計画(A2UI base catalog)
tags: [design-system, a2ui, surfaces, ui-ux]
last_updated: 2026-09-23
mission: MSN-SURFACE-UI-UNIFY-20260923
---

# サーフェス UI 統一計画(UI-01〜UI-10)

## 1. 背景(ヒアリング結果 2026-09-23)

利用者の不満は「見た目がバラバラ」「何をすればいいか分からない」「見た目が古い/安っぽい」。対象は 5 サーフェスすべて。

| サーフェス            | 現状の主な問題                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 秘書室(concierge)     | 独自色(茶)。トークン生成対象外で `globals.css` 1,491 行に生 hex。本文カラムが狭く余白過多                          |
| 相棒(presence-studio) | 同じレールなのに teal。ホームが狭く空白が大きい                                                                    |
| 管制塔(chronos)       | タブ 11 個が 2 段折返し。ヒーローが「読み取っています…」。大文字 mission ID と同形カードの羅列。ガラス調で安っぽい |
| 監査モニタ(operator)  | 素の HTML テーブル・下線リンク・英語のみ。状態が色文字だけ                                                         |
| computer-surface      | 暗グラデ+ガラスでコントラスト不足、First run 案内が判読不能、開発者 sandbox が常時露出                             |

技術的な根本原因: A2UI はメッセージ形式だけで **コンポーネントの定義(props の契約)がない**。唯一のレンダラは chronos 内の React+Tailwind(`A2UIComponentLibrary.tsx`)。各サーフェスは別スタック(Next×3 / Express 静的 HTML×2)で、それぞれ独自 CSS を持つ。

## 2. 合意した方針

1. **共通デザイン基盤 → 全サーフェスへ順次適用**。1 PR にまとめる。
2. **基本 UI 部品は A2UI コンポーネントとして定義**する(catalog `kyberion-base`)。props は JSON Schema で契約化し、`validateA2UIMessage` が catalog 既知の型について props も検証する。
3. **見た目の実体は 1 枚の CSS**(`kyberion-ui.css`、トークンから生成/同梱)。レンダラは props → マークアップ(`kb-*` クラス)の薄い写像に徹し、React 版と vanilla DOM 版の 2 つを持つ。静的 HTML サーフェスは A2UI を使わず同じクラスを直接書いてもよい(クラス契約が正)。
4. **ブランド: deep blue**。全サーフェス共通のアクセントを 1 色にし、サーフェス固有の「役割色」はヘッダの役割バッジとナビの active 表示にだけ使う。
5. **light / dark 両対応**。`:root[data-theme]` + `prefers-color-scheme`。両テーマで WCAG AA(本文 4.5:1、UI 部品 3:1)。
6. **密度は画面ごと**: フロントデスク(秘書室・相棒)= `comfortable`(平易な日本語、ID を隠す、次の一手が最上位)、管制塔・監査モニタ = `compact`(一覧性・情報密度)。`data-density` 属性で切替。

## 3. `kyberion-base` catalog(UI-01)

型 ID は `ui:` 接頭辞。既存の `text`/`button`/`card`/`container` は対応する `ui:*` の別名として扱う。chronos の `display:*` のうち重複するもの(table/kv/metric/status/alert/list/timeline/progress/badges/section)は同じ CSS クラスで描画し、段階的に `ui:*` へ寄せる(`display:*` の型は互換のため残す)。

| 区分       | 型                     | 主な props                                                                    |
| ---------- | ---------------------- | ----------------------------------------------------------------------------- |
| 骨格       | `ui:app-shell`         | `density`, `theme?`; children = nav / header / main                           |
|            | `ui:page-header`       | `title`, `subtitle?`, `role_badge?{label,tone}`, `actions?`                   |
|            | `ui:nav-rail`          | `items[{id,label,hint?,href,icon?,active?}]`, `footer_items?`                 |
|            | `ui:tabs`              | `items[{id,label,count?,href?}]`, `active`, `overflow: 'wrap'                 | 'menu'`                                 |
| レイアウト | `ui:stack` / `ui:grid` | `gap`, `columns?`(grid は auto-fit)                                           |
| 内容       | `ui:section`           | `title?`, `description?`, `tone?`, `actions?`                                 |
|            | `ui:next-action`       | `eyebrow?`, `title`, `reason?`, `primary{label,href                           | action}`, `secondary?`, `state: 'ready' | 'loading' | 'empty'`                             |
|            | `ui:metric`            | `label`, `value`, `unit?`, `delta?`, `tone?`                                  |
|            | `ui:kv`                | `items[{label,value,mono?}]`                                                  |
|            | `ui:table`             | `columns[{key,label,align?,mono?,width?}]`, `rows`, `row_href_key?`, `empty?` |
|            | `ui:list`              | `items[{title,meta?,status?,href?}]`, `variant: 'plain'                       | 'timeline'`                             |
|            | `ui:text`              | `text`, `variant: 'body'                                                      | 'muted'                                 | 'caption' | 'mono'                               | 'title'`             |
| 状態       | `ui:status-pill`       | `status`(正規語彙), `label?` — アイコン+文字で、色だけに頼らない              |
|            | `ui:badge`             | `label`, `tone`                                                               |
|            | `ui:callout`           | `tone: info                                                                   | success                                 | warning   | danger`, `title`, `body?`, `action?` |
|            | `ui:empty-state`       | `title`, `body?`, `action?`                                                   |
|            | `ui:skeleton`          | `lines?`, `shape: 'text'                                                      | 'card'                                  | 'table'`  |
| 操作       | `ui:button`            | `label`, `variant: primary                                                    | secondary                               | danger    | ghost`, `href                        | action`, `disabled?` |
|            | `ui:disclosure`        | `summary`, `open?` — 開発者向け要素を畳むため                                 |

- 正本: `knowledge/product/schemas/a2ui-catalog-kyberion-base.schema.json`(型ごとの props schema)+ `libs/core/a2ui-catalog.ts`(型・検証・catalog ID 定数)。
- `status-pill` の語彙は既存のダッシュボード状態語彙(ui-ux governance check が見ている語彙)に合わせ、日本語ラベルは i18n 辞書から引く。
- `ui:page-header.role_badge` の文言は `surface-roles.json` の `role_ja` / `tagline_ja` を正とする。

## 4. トークンと CSS(UI-02)

- `kyberion.json` に Web UI 用の意味トークン層 `tokens.ui`(light/dark)を追加する。既存の `tokens.colors` は media(pptx/動画)も使うため値を変えない。
  - 面: `canvas`, `surface`, `surface-raised`, `surface-sunken`, `border`, `border-strong`
  - 文字: `text`, `text-muted`, `text-subtle`, `text-on-accent`
  - アクセント(deep blue): `accent`, `accent-hover`, `accent-soft`(背景), `accent-text`, `focus-ring`
  - 状態: `success|warning|danger|info` × `{fg, bg, border}`
  - 役割色: `role.concierge`, `role.presence-studio`, `role.chronos-mirror-v2`, `role.operator-surface`, `role.computer-surface`(バッジ/active 限定)
  - 形: `radius.{sm,md,lg}`, `shadow.{sm,md}`(控えめ。ガラス/ぼかし/グラデーション背景は廃止), `space.*`, `font-size.*`(comfortable/compact の 2 スケール)
- `scripts/generate_design_tokens.ts` が `--kb-ui-*` 変数と `kyberion-ui.css`(コンポーネントクラス)を各サーフェスへ出力する。**concierge を生成対象に追加**。
- `check_ui_ux_governance.ts` の生色禁止を operator だけでなく全サーフェス(生成ファイル除く)へ拡張。既存違反は ratchet ベースラインで固定し、本計画で触る画面は 0 にする。
- `check_design_contrast.ts` に `tokens.ui` の light/dark 全組合せを追加。

## 5. レンダラ(UI-03 / UI-04)

- **React**: 新パッケージ `libs/shared-ui`(`@agent/shared-ui`)。`A2UIRenderer`(catalog 型 → コンポーネント)と、各 `ui:*` をそのまま使える React コンポーネントを export。ビルド済み ESM を出荷し、Next 3 面から使う(`@agent/core` の server-external 設定とは別に client から import 可能にする)。
- **vanilla**: `libs/shared-ui/vanilla/`(依存なしの ES module 1 本)。`renderA2UI(container, components)`。presence-studio / computer-surface が static 配信する。
- **ギャラリー**: 全 `ui:*` を light/dark × comfortable/compact で並べる静的ページ。presence-studio の `/ui-gallery` で配信し、スクリーンショットの基準にする。

## 6. サーフェス適用

| ID    | 対象             | 内容                                                                                                                                                                                                                                                                              |
| ----- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-05 | 共通レール       | `ui:nav-rail` 1 実装を concierge(React)と presence-studio(vanilla)で共有。定義は従来どおり `front-desk-nav.ts`                                                                                                                                                                    |
| UI-06 | 秘書室・相棒     | 共通トークンへ移行(茶/teal 廃止)。本文カラム拡幅、ホーム/決めるの最上位に `ui:next-action`。承認カードを `ui:section`+`ui:button` へ                                                                                                                                              |
| UI-07 | 管制塔           | タブ 11 → 5 グループ(ホーム / 仕事 = ミッション・作業一覧・成果物 / 判断 = 承認・ナレッジ / 運用 = 運用・画面の管理・診断 / 組織)。ヒーローは実データの `ui:next-action`、読込中は `ui:skeleton`。mission ID は人間向けタイトル+ID は mono の補助表示。ガラス調廃止。compact 密度 |
| UI-08 | 監査モニタ       | `ui:app-shell`+`ui:table`+`ui:status-pill`。日本語化(i18n)、compact 密度、読み取り専用バッジ維持                                                                                                                                                                                  |
| UI-09 | computer-surface | 標準テーマへ移行(暗グラデ廃止)でコントラスト解消。First run は `ui:empty-state`、sandbox は `ui:disclosure` + 開発者フラグ時のみ表示                                                                                                                                              |
| UI-10 | 検証と文書       | Playwright で before/after(light/dark)撮影、README/SURFACES の画像更新、`DESIGN_SYSTEM.md` に catalog とクラス契約を追記                                                                                                                                                          |

## 7. 進め方

- Wave 1: UI-01〜04(基盤)→ **ギャラリーで見た目を確認して合意** → Wave 2: UI-05/06 → Wave 3: UI-07 → Wave 4: UI-08/09 → Wave 5: UI-10。
- 各 wave はサブエージェント実装 + 独立レビュー + ゲート(vitest、`pnpm check -- --only ui-ux`、contrast、`--scope pr`)。
- 触らないもの: A2UI メッセージの op 形式、`kb-*` Chronos 固有コンポーネントの意味、各サーフェスの API と認可。見た目とマークアップだけを変える。

## 8. 受け入れ条件

- `kyberion-base` の全型に props schema があり、未知 props / 型不一致を `validateA2UIMessage` が拒否するテストがある。
- 5 サーフェスが同じトークンと `kyberion-ui.css` を読み、生色の新規追加が 0。
- light/dark 両方で主要画面のコントラストが AA を満たす(自動チェック)。
- 管制塔のタブが 1 行に収まり(1280px 幅)、各サーフェスのファーストビューに「次の一手」または目的の一覧がある。
- before/after スクリーンショットがミッション evidence と PR に添付されている。
