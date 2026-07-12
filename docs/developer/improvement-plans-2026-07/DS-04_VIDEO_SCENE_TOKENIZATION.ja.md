# DS-04: 動画シーンテンプレートのトークン化

> 優先度: P2 / 規模: S〜M / 依存: DS-01 / 関連: [VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN](../VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN.ja.md)(配管は VDS-01/02/08 で完了済み。本計画は同計画が**カバーしていない**シーンテンプレート内部のトークン化)

## 背景と課題

- VIDEO_DESIGN_SYSTEM_INTEGRATION_PLAN により、brief → storyboard → composition ADF への **css_vars の配管は完成している**(VDS-01/02)。PPTX への正規化ブリッジ(VDS-08、`media-actuator/src/index.ts:1397-1417`)も実装済み。
- しかし配管の**終端**である `libs/core/video-composition-compiler.ts`(1,387行)のシーン HTML テンプレートは、数百個のリテラル hex(既定背景 `#0B1020` `:18`、`#93c5fd`、`#60a5fa`、`#f59e0b`、`#060913`、`#fecaca` 等)で描かれており、トークン対応は `var(--bg, …)`/`var(--text, …)`/`var(--font-sans, …)` の 3 変数のフォールバックのみ。**css_vars を渡してもシーンの大半の色は変わらない**。
- `visual-workflow-compiler.ts`(110行)にはトークンが一切ない。
- つまり DS-02(テナントブランド動画)を実装しても、実際に変わるのは背景と文字色程度 — 本計画がその残りを埋める。

## 実装ステータス

- `video-composition-compiler.ts` のシーン HTML は `--kb-*` 系トークンへ置換済みで、既定値は fallback に保持している。
- `video-design-system.ts` へ動画向けの共有 CSS 変数群を追加済みで、`visual-workflow-compiler.ts` も同じ変数セットを返す。
- `video-composition-compiler.test.ts` と `visual-workflow-compiler.test.ts` で、トークン化出力と共有 CSS 変数を検証済み。
- 残作業は Task 4 の実写/スクリーンショット検証のみ。

## ゴール(受入条件)

1. シーンテンプレート内の色・フォント指定が、正準トークン由来の CSS 変数(`--kb-*` 系。既存 3 変数は互換維持)に置き換わり、css_vars の差し替えでシーン全体の見た目が変わる。
2. 既定トークン(css_vars 未指定)での出力が現行とピクセル同等(または意図した軽微差のみ)であることが確認される。
3. `visual-workflow-compiler.ts` にも同じ変数群が導入される。
4. アクセントの階調(`#93c5fd`/`#60a5fa` のような近縁色)は「accent の明度バリアント」としてトークン側で定義され、テンプレートが勝手に中間色を発明しない。

## 実装タスク

### Task 1: 色インベントリとトークン対応表 — `claude-sonnet-4`

1. `video-composition-compiler.ts` 内の全 hex リテラルを抽出し(`grep -o '#[0-9a-fA-F]\{3,8\}' | sort | uniq -c`)、出現箇所の役割(背景/パネル/アクセント/警告/テキスト/罫線)を分類した対応表を作る。
2. 対応表を DS-01 の正準トークン(+ 明度バリアント: `--kb-accent-soft`/`--kb-accent-strong` 等、必要最小限)にマップし、本文書末尾に追記する。トークンに写像できない装飾色が残る場合は「シーン固有トークン」として scene template のローカル変数に落とす(リテラル直書きには戻さない)。

### Task 2: テンプレート置換 — `claude-sonnet-4`(最初の 2 シーン種でパターン確立)→ `claude-haiku`(残りを対応表添付で横展開)

1. sonnet: 代表的なシーン種 2 つで `#xxx` → `var(--kb-*, #xxx)`(**フォールバックに現行値を残す**)置換のパターンを確立。既定出力が変わらないことをレンダリングテスト(既存の video-render-runtime テスト)で確認。
2. haiku: 残りのシーンテンプレートを対応表どおり機械的に置換。1 シーン種ごとにコンパイル(ADF 生成)テストを実行。
3. `visual-workflow-compiler.ts` にも同変数を導入。

### Task 3: デフォルトテーマの外部化 — `claude-sonnet-4`

- `:18` 等の既定値ハードコードを、DS-01 の正準トークン(video プロファイル)から解決する 1 関数に集約する。css_vars 未指定時はこの既定が入るため、出力互換が保たれる。

### Task 4: テナントブランド動画の実証 — `claude-sonnet-4`(DS-02 Task 3 完了後)

- ダミーテナント(client-a)の palette で brief → ADF → 1 シーンのレンダリングまで通し、シーン内のパネル・アクセント色が変わることをスクリーンショットで確認して本文書に結果を記録する。

## リスクと注意

- 動画は視覚回帰の自動検証が難しい。**フォールバック値に現行 hex を残す**方式により「css_vars 未指定 = 現行と同一」を構造的に保証し、置換ミスはコンパイルテストとサンプルレンダリングで捕まえる。
- 明度バリアントのトークン追加は DS-01 の正準モデルに逆流させる(video 専用の野良トークンを増やさない)。

## 実装状況 追記(2026-07-12 — agy 縦型ショート動画の品質修復)

- **原因診断**: (1) scene の見た目が compiler 内ハードコード CSS(紺一色・68px 見出し・単一骨格)で、LLM はテキスト欄のみ供給 = ストーリーに合わせた art direction が構造的に不可能。(2) `visual_steps` 欠落時に英語デモ工程(Brief intake / Content plan / Render package)が実動画へ混入。(3) 9:16 縦型でも横型と同じタイポグラフィスケール。
- **修復**: `libs/core/video-visual-direction.ts` 新設 — reasoning backend がストーリー(storyboard beats / narration)から visual direction(mood・6色パレット・タイポスケール・scene 別 layout_variant)を JSON 起草(LLM zone)→ スキーマ検証 + クランプ(hex 必須・縦型は 72–132px 等、compiler zone は決定論維持)→ 失敗時は旧既定へ縮退(レンダを絶対に止めない)。既存の `--kb-*` トークン間接層に `:root` 注入で適用、font-size もトークン化。actuator の narrated 系2アクションへ自動配線。プレースホルダ工程図は全廃(契約テストも新契約へ更新)。
- テスト: direction 検証6本 + compiler/narrated/actuator/render 計38本緑。

### 追記(2026-07-13 — 選択方式への転換)

- オペレータ指摘(生成 + 検証は縮退しがち)を受け、**生成 → カタログ選択**へ転換: `knowledge/public/design-patterns/media-templates/video-visual-patterns.json` に5つのキュレーション済みパターン(calm-tech / warm-documentary / bold-pop / fresh-clarity / midnight-executive、各 portrait/landscape タイポ調整済み)を新設し、LLM は id を選ぶだけ(カタログ外 id は先頭パターンへ縮退)。pptx の themes.json 選択(`deck-theme-direction.ts`、brief 明示指定はオペレータ優先)と対になる構造。
