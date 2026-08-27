---
title: DS 06 CHRONOS LIGHT THEME
tags: [improvement-plan, 2026-07]
last_updated: 2026-07-31
status: archived
---

# DS-06: chronos light テーマの実装完了 — コンポーネント層のトークン化

> 優先度: P2 / 規模: L / 依存: DS-01(トークン一元化・完了済) / 関連: DS-05(light/dark トグルを導入した計画), IP-10(god file 分解)

## 背景と課題

DS-05 の受入条件2「chronos が light/dark 両モードを持ち、`prefers-color-scheme` 追従 + 手動トグルで切替できる」は、**トグルと token 層だけが実装され、コンポーネント層が追従していなかった**。2026-07-26 の実測で判明した内容:

- `webThemePackToCssVars`(`libs/core/web-design-system.ts`)は `--kb-panel-bg` を **全テーマで `primary @ 0.82`** として導出していた。light テーマでは `primary` が**インク色**なので、panel が濃色になり、その上に `--kb-text-primary`(同じ濃色)が乗って**コントラスト比 1.0**(不可視)になっていた。concierge・presence-studio も同じ欠陥を踏んでおり、presence-studio は `--kb-panel-bg` の**ローカル上書きで手当てしていた**。
- 同関数は `--kb-border` を **`1px solid rgba(...)` という border ショートハンド**として出力していた。リポジトリ内の全消費側は `1px solid var(--kb-border)` と書く(静的 `design-tokens.css` も色として定義)ため、この vars が適用される範囲では **border 宣言そのものが無効化**されていた。

上記2点は 2026-07-26 に修正し、`scripts/check_design_contrast.ts` を**導出後の theme pack(chronos dark/light・concierge・companion)まで検証する**ように拡張して CI ゲートに載せた。

しかし **token を正しく light にした結果、コンポーネント層が dark 専用であることが露出した**。実測(Playwright + WCAG 相対輝度、alpha 合成込み):

| モード | 閾値未満の要素数 | 内容                                                                                                                      |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| dark   | 208              | 主に装飾的な極小文字(`text-white/25` の 9px タイムスタンプ ≈ 2.2:1)。既存の設計選択であり本計画の対象外(DS-05 の残タスク) |
| light  | **1,866**        | `text-white/72` / `bg-black/20` / `text-cyan-100/80` のような **dark 専用ユーティリティが light panel 上に乗る**          |

chronos `src` 配下の実数: **text 系カラーユーティリティ約 939 箇所、bg/border の white/black 系約 650 箇所**(`page.tsx` 2,800行 + `MissionIntelligence.tsx` 5,800行が大半)。

## 暫定対応(2026-07-26 実施済み)

`src/lib/chronos-theme.ts` を新設し、**`system` が light に解決されないように**した。

- 変更前: `system` は `prefers-color-scheme` に追従 → **light モードの OS を使う operator は、自分で選んでいないのに毎回読めない画面を開いていた**。
- 変更後: chronos は dark コンソールとして解決する。ヘッダのトグルは `system` / `dark` のみを巡回する(`CHRONOS_THEME_CYCLE`)。
- `resolveChronosThemeMode('light', …)` は引き続き `'light'` を返す(経路をテスト可能に保つため)。
- 回帰は `src/lib/chronos-theme.test.ts` で固定(6本)。

**light を「未実装として提示しない」状態であり、実装完了ではない。** 本計画がその完了分である。

## ゴール(受入条件)

1. chronos の `src` 配下から、ハードコードされた dark 専用カラーユーティリティ(`text-white/*`・`text-slate-*/*`・`text-cyan-100/*`・`bg-black/*`・`border-white/*` 等)が**0件**になり、すべて `--kb-*` トークン経由になる。
2. `CHRONOS_THEME_CYCLE` に `light` を戻し、`resolveChronosThemeMode` の `system` を `prefers-color-scheme` 追従に戻す。
3. **light / dark の両モードで**、DOM 実測のコントラスト閾値未満(通常 4.5:1・大文字 3:1)が **0件**になる。dark 側の既存 208件もこの過程で解消する。
4. 実測が CI で回る(`scripts/` に DOM コントラスト計測を追加し、`pnpm validate` 相当のチェーンへ接続)。

## 実装タスク

### Task 1: セマンティックカラークラスの語彙を決める

`text-white/45`(45種以上のアルファ差分)を 1:1 で移植しようとすると破綻する。**用途別の少数の語彙**へ畳む:

- `kb-text-primary` / `kb-text-secondary` / `kb-text-muted`(3段の本文)
- `kb-surface-raised` / `kb-surface-sunken`(panel 内の chip/well 背景)
- `kb-border-subtle` / `kb-border-strong`
- tone 系 4種(approve / reject / info / alert)。`page.tsx` の `toneChipClass` が既にこの形で、light/dark 両方の値を持つ**参照実装**になっている。

各語彙を `globals.css` の `@layer components` に light/dark 両値で定義する(トークンは DS-01 の `--kb-*` を参照する)。

### Task 2: 機械的置換 + 目視差分

用途語彙へのマップを作り、ファイル単位で置換する。**`MissionIntelligence.tsx` は IP-10 の分解と同時に行うのが効率的**(5,800行を一括置換した差分はレビュー不能)。各ファイルで dark モードのスクリーンショット差分を取り、**dark の見た目が変わっていないこと**を確認する(これが移植の正しさの担保になる)。

### Task 3: DOM コントラスト計測を CI へ

トークン単体の `check:design-contrast` では今回の欠陥は**捕まらなかった**(トークンは正しく、コンポーネントが従っていなかった)。実 DOM を alpha 合成込みで計測するチェックを追加する。計測ロジックは 2026-07-26 の調査で使ったものが流用できる(`資料`: 相対輝度 + `src over dst` 合成 + WCAG 大文字閾値の判定)。

### Task 4: light を戻す

受入条件2を実施し、`chronos-theme.test.ts` の「light を提示しない」テストを「両モードを提示する」テストへ置き換える。

## 実装状況

**DONE (2026-07-27)**。

- `globals.css` に本文・補助・ミュート・アクセント、面、境界、approve/reject/info/alert のセマンティック語彙を追加し、light/dark の値を `--kb-*` に集約した。
- Chronos のコンポーネント全体(`page.tsx`、`MissionIntelligence.tsx`、共有 panels)から白/黒/Slate/Cyan 等の dark 専用 utility を除去し、`kb-*` 語彙へ移行した。status/gradient/IdentityBadge の直接色参照も同じカスケードへ統合した。
- `CHRONOS_THEME_CYCLE` は `system → light → dark` を提示し、`system` は `prefers-color-scheme` に追従する。
- `scripts/check_chronos_dom_contrast.ts` を追加し、Playwright で light/dark + reduced-motion の実 DOM を alpha 合成込みで計測する。`check:chronos-dom-contrast` と `validate` に接続した。
- 検証結果: light/dark の DOM コントラスト違反 0件、`check:design-contrast`、typecheck、Chronos lint/build、テーマ回帰テストが緑。
