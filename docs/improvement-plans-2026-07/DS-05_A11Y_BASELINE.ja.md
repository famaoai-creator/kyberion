# DS-05: アクセシビリティ基盤 — reduced-motion・カラースキーム・コントラスト・ARIA

> 優先度: P2 / 規模: M / 依存: DS-01(トークン一元化後が効率的) / 関連: UX-01/02(エラー・進捗の提示)

## 背景と課題

Web 面のアクセシビリティ配慮が実質ゼロで、計測もされていない。

- **`prefers-color-scheme` / `prefers-reduced-motion` がリポジトリ全体でゼロ**。各面はモード固定(chronos/operator/computer = dark 固定、presence-studio = light 固定)で、ユーザー側の設定に一切追従しない。
- chronos は **常時稼働の `pulse-cyan` アニメーション**(`chronos-mirror-v2/src/app/globals.css:44-52`)を reduced-motion ガードなしで回している(前庭障害・注意持続への配慮欠如、および常時 GPU 消費)。
- **ARIA/ロールの使用実態**: operator-surface **0**、chronos 全体で **3**(FirstRunBanner 1 + FocusedOperatorView 2)、computer-surface 1、presence-studio 12(最良)。UX 調査でも判明済み: SovereignChat のアイコンボタン(最小化 `:211`・マイク `:299`・送信 `:309`)に `aria-label` 無し、メッセージコンテナに `role="log"`/`aria-live` 無し(スクリーンリーダーに新着が通知されない)。
- **コントラスト検証の仕組みが無い**(ツール・テストともにゼロ)。KDS の Steel Ghost `#94A3B8` on Kyberion Blue `#0A192F` のような組合せが WCAG AA を満たすかは未確認。
- 生成文書(PPTX/PDF)側のコントラストも themes.json のテーマ定義に対する検証が無い。

## ゴール(受入条件)

1. 全 Web 面が `prefers-reduced-motion` を尊重する(常時アニメーションはガード付きになる)。
2. chronos が light/dark 両モードを持ち、`prefers-color-scheme` 追従 + 手動トグル(UX-03 の言語トグルと同じ場所)で切替できる。DS-01 のトークンが light バリアントを持つことが前提。
3. 正準トークンの色ペア(text on bg / text on surface / accent on bg 等)に **WCAG AA(4.5:1、大文字 3:1)のコントラスト検証**が入り、CI でゲートされる。themes.json の 8 テーマも同検証を通す(不合格テーマは値を補正)。
4. chronos と operator-surface の対話要素に ARIA の基礎(アイコンボタンの `aria-label`、チャットの `role="log"` + `aria-live="polite"`、フォーカス可視化)が入る。

## 実装タスク

### Task 1: reduced-motion ガード — `claude-haiku`

- 各面のアニメーション定義(chronos `globals.css:44-52` の pulse-cyan ほか、`animation`/`transition` の常時系を grep)に `@media (prefers-reduced-motion: reduce)` での停止/減速を追加する。挙動確認は OS 設定切替で目視。

### Task 2: コントラスト検証スクリプト — `claude-sonnet-4`

1. `scripts/check_design_contrast.ts` を新設: 正準トークン(DS-01 の `brand-tokens/*.json`)と `themes.json` の各テーマについて、定義済みの「前景×背景ペア一覧」(トークンスキーマに `contrast_pairs` として宣言)の相対輝度比を計算し、AA 未満で exit 非0。依存追加なしで実装可能(輝度計算は 20 行程度)。
2. `pnpm validate` チェーンに `check:design-contrast` を追加。現状の不合格ペアは**トークン値の補正**(明度調整)で解消し、補正一覧を PR/パッチ説明に記載する。テナント pack(confidential)は警告のみ(顧客ブランド色は強制補正しない)。

### Task 3: chronos の light/dark 対応 — `claude-sonnet-4`

1. DS-01 の light バリアントトークンを chronos に配線: `:root` は `prefers-color-scheme` で切替、`data-theme` 属性による手動オーバーライド(localStorage 永続、UX-03 のトグルと並置)。
2. ハードコード色が残っていて light で破綻する箇所を洗い(Task 2 のペア検証 + 目視)、`var(--kb-*)` へ置換。
3. スクリーンショット(light/dark)を PR/パッチ説明に添付。

### Task 4: ARIA 基礎 — `claude-sonnet-4`(chronos)→ `claude-haiku`(operator-surface 横展開)

1. chronos: SovereignChat のアイコンボタン 3 つに `aria-label`、メッセージリストに `role="log"` + `aria-live="polite"`、確認モーダル(UX-04 Task 4)に `role="dialog"` + フォーカストラップ、ホットキー(1-7)の存在を `aria-keyshortcuts` で表明。フォーカスリング(presence-studio の `focus-visible` 実装 `design-system.css:246-253` を移植)。
2. operator-surface: リンク・テーブルのラベル付けを chronos のパターンに従って付与(read-only なので対象は少ない)。
3. 検証: axe-core 等の導入は依存が増えるため任意。最低限、キーボードのみで chronos の主要操作(チャット送信・承認)が完了することを手動確認して記録する。

## リスクと注意

- light モード追加は「dark 前提でデザインされた KDS」の世界観(Sovereign Command)を薄める可能性がある。**dark を既定のまま**にし、light は追従オプションと位置づける(CHRONOS_A2UI_SPEC にその旨を追記)。
- コントラスト補正でブランドカラーの印象が変わる場合は、値の変更を独立コミットにし、before/after を明示する。
- 完全な WCAG 準拠(スクリーンリーダー完全対応等)は本計画のスコープ外。「基礎の敷設 + 再発防止ゲート」までとする。
