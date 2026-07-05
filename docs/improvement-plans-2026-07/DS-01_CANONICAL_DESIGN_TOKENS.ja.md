# DS-01: 正準デザイントークンと Web 4 面の統一

> 優先度: P1 / 規模: M / 依存: なし / 後続: DS-02(テナント適用)、DS-04(動画)、DS-05(a11y)

## 0.1 実装ステータス(2026-07-05 時点)

- 実装済み: `knowledge/public/design-patterns/brand-tokens/kyberion.json` を正本とするトークン生成、4 面の token CSS 生成、`themes.json` への Kyberion テーマ反映、`docs/developer/design/DESIGN_SYSTEM.md` の統括文書化
- 追加実装: `check:catalogs` に Kyberion token drift 検査を接続し、generated output とコミット済みファイルの一致を強制
- 残作業: operator-surface の残 hex 置換と、DS-02/DS-04/DS-05 に向けた面別配線の最終整理

## 背景と課題

視覚デザインの「正」が存在せず、面ごとに独立進化している。

- **Web 4 面で 4 つの非互換パレット**: chronos-mirror-v2 は KDS "Sovereign Command"(`#020617`/Pulse Cyan `#00F2FF`)、operator-surface はインラインスタイルで `#0c0d10`/`#8ec3ff`(約250 の `style={{}}`、約125 のハードコード hex。`src/app/layout.tsx:17-53` が典型)、presence-studio は独自**ライト**テーマ(`static/design-system.css:1-15`)、computer-surface は独自ダークティール(`static/index.html:8-23`)。共有トークン源はゼロ。
- **KDS 自体が三重管理**: 同じ `--kb-*` hex が (1) `docs/developer/design/CHRONOS_A2UI_SPEC.md` §4、(2) `libs/core/web-design-system.ts` の `DEFAULT_CHRONOS_WEB_THEME_PACK`(`:196`)、(3) `chronos-mirror-v2/src/app/globals.css:5-21` で手動維持されている。さらに **`tailwind.config.cjs` の `colors.kyberion` は無関係の第3パレット(gold `#D4AF37`/`#0F0F0F`)で KDS と矛盾**。
- **色語彙が3系統**: Web `--kb-*` / ダイアグラム(`diagram-renderer/theme-registry.json` の mermaid 語彙 `primaryColor`)/ メディア(`themes.json` の `colors.primary`)。橋渡しは media 側の一方向ブリッジ(`media-actuator/src/index.ts:1397-1417` の css_vars→palette)のみ。
- 全体を束ねる DESIGN_SYSTEM 文書が無い(`CHRONOS_A2UI_SPEC.md` は web のみ、`theme-and-design-system-reference.md` は media のみ)。

なお `web-design-system.ts` の pack モデル(`WebThemePack` → `webThemePackToCssVars`)と、media 側の層構造(themes.json / layout-presets / semantic-tokens / design-systems)は**設計として良い**。問題は「正準が無い・配線されていない」ことに尽きる。

## ゴール(受入条件)

1. **正準ブランドトークンモデル**が 1 箇所に定義され(既存 `web-design-system.ts` の pack モデルを昇格)、そこから (a) `--kb-*` CSS 変数、(b) tailwind トークン、(c) media `themes.json` palette、(d) diagram mermaid 語彙、への**アダプタ(生成)**が存在する。
2. Web 4 面すべてが同一のトークン源から色・フォントを取得する(presence-studio のライトテーマは「同一トークンモデルの light バリアント」として正式化)。
3. KDS の三重管理が解消: `globals.css` と tailwind トークンは pack から生成され、手で編集しない。矛盾する gold パレットは削除(利用箇所を grep で確認の上)。
4. `docs/developer/design/DESIGN_SYSTEM.md`(統括文書)が新設され、web/media/diagram/video の各語彙と正準トークンの対応表を持つ。

## 実装タスク

### Task 1: 正準トークンモデルの確定 — `claude-opus`(設計)

1. `web-design-system.ts` の `WebThemePack` と media 側 `themes.json`・`corporate-design-adf.schema.json` の語彙を突き合わせ、正準モデル(色役割: bg/surface/text/accent/warning/…、フォント役割: heading/body/mono + 日本語スタック、モード: dark/light)を定義する。既存 pack のスーパーセットとし、破壊的変更を避ける。
2. 各レンダラ語彙へのマッピング表(正準 → `--kb-*` / tailwind / themes.json / mermaid)を本文書末尾に追記して実装へ渡す。

### Task 2: トークンパッケージとアダプタ生成 — `claude-sonnet-4`

1. トークン定義を `knowledge/public/design-patterns/brand-tokens/kyberion.json`(スキーマは `schemas/` に追加)として外部化し、`web-design-system.ts` はこれを読む形に変更(既定値ハードコードは fallback として残す)。
2. `scripts/generate_design_tokens.ts` を新設: 正準トークンから `globals.css` の `:root` ブロック、tailwind 用トークン(`tailwind.config.cjs` が読む JSON)、mermaid theme-registry エントリ、themes.json の `kyberion-standard`/`kyberion-sovereign` を生成する。生成物とコミット済みファイルの一致を `check:catalogs` 系でゲート(手編集の検出)。
3. tailwind の `colors.kyberion`(gold)は利用箇所を grep で確認し、未使用なら削除、使用中なら正準トークンへ置換。

### Task 3: operator-surface のトークン化 — `claude-sonnet-4`(パターン確立)→ `claude-haiku`(残ファイル横展開)

1. sonnet: operator-surface に生成 CSS(`--kb-*`)を導入し、`layout.tsx` と `CapabilityDashboard.tsx` の 2 ファイルでインライン hex → `var(--kb-*)` 置換のパターンを確立する(read-only の質実な見た目は維持。色相を chronos に寄せるだけで、レイアウトは変えない)。
2. haiku: 残りのファイル(`surfaces/page.tsx` 39箇所、`missions/[id]/page.tsx` 36箇所ほか)をパターンに従い機械的に置換。1 ファイルごとに `pnpm --filter @presence/operator-surface typecheck`(あれば)+ ビルド確認。

### Task 4: presence-studio / computer-surface の接続 — `claude-sonnet-4`

- 両者の `:root` トークン定義を生成 CSS の light/dark バリアントに置換する(静的 HTML なので生成 CSS ファイルを `static/` にコピーするビルドステップでよい)。presence-studio の日本語フォントスタック(`design-system.css:23`)は**正準トークンの body フォント定義に昇格**させ、全面が継承する(DS-03 と整合)。

### Task 5: 統括文書 — `claude-sonnet-4`

- `docs/developer/design/DESIGN_SYSTEM.md` を新設: 正準トークン、面ごとの適用方法、アダプタ生成コマンド、新しい面を作るときのチェックリスト。`CHRONOS_A2UI_SPEC.md` と `theme-and-design-system-reference.md` から相互リンク。`docs/ROADMAP.md` には登録不要(計画でなく規約文書)。

## リスクと注意

- 見た目の変化はユーザーに直接見える。**operator-surface の色替えは before/after のスクリーンショットを PR/パッチ説明に添付**する。presence-studio のライトテーマは変えない(light バリアントとして正式化するだけ)。
- 生成ゲートを入れる前に、既存の手編集値と生成値の diff を必ず確認し、意図的な調整(コントラスト補正等)を正準側に取り込んでから切り替える。
