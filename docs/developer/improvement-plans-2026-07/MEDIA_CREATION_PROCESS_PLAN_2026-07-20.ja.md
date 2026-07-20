# メディア生成プロセス改善計画 — HyperFrames / Anthropic Skills の作成プロセス移植

- 作成日: 2026-07-20
- 状態: 提案（Alignment フェーズ成果物・未着手）
- 関連: [LAYERED_EXECUTION_PLAN_2026-07-15](./LAYERED_EXECUTION_PLAN_2026-07-15.ja.md) · [DS-01](./DS-01_CANONICAL_DESIGN_TOKENS.ja.md) · [DS-03](./DS-03_DOCUMENT_THEME_JP_TYPOGRAPHY.ja.md) · [DS-04](./DS-04_VIDEO_SCENE_TOKENIZATION.ja.md) · [MO-08](./MO-08_ARTIFACT_REVIEW_CLOSURE.ja.md)

## 0. 要約

kyberion のメディア出力（HyperFrames 動画・PPTX）は「配管（トークンの一元化）」は LE/DS 系計画で解決済みだが、**「作成プロセス」が本家（HeyGen HyperFrames の skills 群・Anthropic 公式 skills）と根本的に異なる**ため、デザイン品質が頭打ちになっている。差は 3 点に集約される:

1. **本家は LLM がシーンを設計する。kyberion は LLM がテキストを流し込むだけ**（構造・モーションは固定コンパイラ内にハードコード）。
2. **本家は「レンダリング結果を視て批評し直す」ループを必須工程にしている。kyberion には視覚検証工程が存在しない**（PPTX の文字ズレはテキスト量とボックスの照合を一度もしないことに起因）。
3. **本家はブリーフ確定 → トークン定義 → ビート設計 → 実装 → lint → 視覚批評、という段階ゲートを持つ。kyberion はブリーフから一気に最終形へコンパイルする**。

本計画は、この 3 つのプロセス差を MP-01〜MP-06 のワークストリームとして kyberion に移植する。

## 1. 診断 — どこでデザイン品質が失われているか

### 1.1 動画（HyperFrames パス）

現行フロー: `VideoContentBrief` → `compileVideoContentBriefToStoryboard()` → `NarratedVideoBrief` → `VideoCompositionADF` → `video-composition-compiler.ts` が HTML/CSS を出力 → `hyperframes` CLI でレンダリング（`libs/core/video-render-backend.ts:111-204`）。

| 問題                                 | 所在                                                                                            | 影響                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| レイアウト・モーションが全て固定 CSS | `libs/core/video-composition-compiler.ts`（約1,387行、`@keyframes` とタイミングがハードコード） | LLM の裁量は「10種のパターンパックから ID を選ぶ＋テキスト充填」のみ。ストーリー固有のアートディレクションが構造的に不可能（DS-04 でも指摘済み） |
| ストーリーボードがテンプレ流し込み   | `video-content-brief-contract.ts:119` の固定 `BeatPlanEntry` テーブル                           | ビート（尺・リズム・モーション意図）が内容と無関係に決まる                                                                                       |
| 視覚レビュー工程なし                 | —                                                                                               | レンダリング結果を誰も視ない。破綻してもそのまま納品                                                                                             |
| 低品質フォールバックが無言で発動     | `video-render-backend.ts:215`（静止画スライドショー）                                           | 品質劣化がユーザーに通知されない                                                                                                                 |

### 1.2 PPTX（native-pptx-engine パス）

| 問題                                              | 所在                                                                                                                  | 影響                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 座標がハードコード幾何                            | `libs/actuators/media-actuator/src/index.ts:588-943`（chrome寸法＋6種 body-zone の switch）、`body-zone-layouts.json` | レイアウト語彙が 6 種で固定                                                                                           |
| テキスト計測なし                                  | 例: `Math.ceil(bodyLines.length * 0.55)`（`index.ts:683`）で機械的にカラム分割                                        | **文字ズレ・オーバーフローの直接原因**。テキスト実寸とボックス高を一度も照合しない。日本語で especially 悪化（DS-03） |
| 視覚QA工程なし                                    | —                                                                                                                     | 生成後のレンダリング検証（PDF化→目視批評）が存在しない                                                                |
| `resolveCreativeDesign` を native engine が未消費 | LAYERED_EXECUTION_PLAN §課題（LE-02 はスタイルのみ接続）                                                              | デザイントークン→スライド幾何のラストワンマイルが断絶                                                                 |

### 1.3 デザイン語彙そのものの貧しさ

`libs/core/creative-design-resolver.ts`: 色 6 ロール、フォントは heading/body が sans に強制同一（`:170,228`）。**タイポグラフィスケール・スペーシング・グリッド・ウェイトコントラストのトークンが存在しない**。本家が最低限とする語彙（後述 §2.2）に遠く及ばず、レンダラー側に散在するリテラル幾何がその穴を埋めている。

## 2. 参照プロセス — 本家は何をしているか（調査結果）

> 注: HyperFrames は **HeyGen 製 OSS**（Anthropic 製ではない。Claude プラグインとして公式リストに掲載）。ユーザー提示の動画（`mvAU9rm5U7k`、チャンネル「AIエージェントの未来」による HyperFrames 解説動画）が「HyperFrames のみで作られた」という点は未確認だが、faceless-explainer ワークフローの典型的な適用例であり整合的。

### 2.1 HyperFrames skills 群の作成プロセス

出典: [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) · [claude-design-hyperframes ガイド](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/claude-design-hyperframes.md)

1. **インテント層**: ルータースキルが最初に完全なブリーフを1会話で確定。「明示された決定」と「推定した決定」を区別して `BRIEF.md` にロック。ストーリーボードレビューの要否などの run-shape 判断もここで決める。
2. **ブランド＝CSS カスタムプロパティ**を `:root` に先に定義。アンチ・モノカルチャー規則（Inter/Roboto/Poppins 禁止、cyan-on-dark 禁止、ウェイト差 300 vs 900 必須、見出し60px/本文20px/ラベル16px の最小サイズ）。
3. **ビート設計を HTML より先に**（`beat-direction.md`）。尺は読了時間から算出（1-3語=2-3秒、35語以上はシーン分割、上限5秒）。
4. **シーン＝宣言的 HTML**（`data-start`/`data-duration`）＋**単一の seek 可能な paused GSAP タイムライン**。シーンごとに entrance tween ＋ ミッドシーンパターン2種以上（ストックライブラリ8種）＋ ease 3種以上。「静止スライド禁止」。トランジションは95%ハードカット、シェーダーは1本に2-3回まで。
5. **決定論規則**: `Math.random()`/`Date.now()`/`setTimeout`/`repeat:-1` 禁止、transform-only tween。→ 同一入力＝同一フレーム。
6. **lint → preview（フレーム精度スクラブ）→ 自己レビューチェックリスト → 納品時に `DESIGN.md`＋次エージェント向け改善提案**。作成エージェントと磨き込みエージェントを分離（「視ずに磨くな」）。

### 2.2 Anthropic 公式 skills（pptx / frontend-design / canvas-design / theme-factory）

出典: [anthropics/skills](https://github.com/anthropics/skills) · [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)

- **pptx skill の視覚QAパイプライン**: 生成 → `soffice --headless --convert-to pdf` → `pdftoppm -jpeg -r 150` → **モデルがレンダリング画像を目視**してオーバーフロー・整列・コントラスト・余白を批評 → 修正。制約: 白背景デフォルト、余白0.5"、「タイトル下のアクセント線・装飾カラーバーは AI 生成の証」として禁止。
- **frontend-design の2パス**: (1) デザイン計画（色トークン4-6・書体ロール2以上と選定理由・レイアウト1文＋ASCIIワイヤー・signature element 1つ）→ (2) コードを書く**前に**計画自体を批評（「同種のどのプロジェクトでも同じ選択をするか? Yes なら作り直し」）。ビルド中はスクリーンショットで視覚批評（"a picture is worth 1000 tokens"）。
- **generator/evaluator ループ**: 評価エージェントが Playwright で実画面をスクリーンショットし、デザイン一貫性・独自性・クラフト・機能性の4基準で採点（独自性を craft より重く配点し、無難な収束を罰する）。5-15 反復。
- **蒸留**: ループで繰り返し出る失敗パターン（Inter・紫グラデ等の「分布収束」）を約400トークンの skill に固定化し、以後はループなしで回避。

### 2.3 収束する共通パイプライン（移植対象）

**①ブリーフ確定（決定をロック）→ ②デザイントークン先行定義 → ③ビート/ページ設計（尺・密度バジェット付き）→ ④宣言的実装 → ⑤構造 lint → ⑥検分可能な形にレンダリング（フレーム/サムネイル）→ ⑦ルーブリックに基づく視覚批評（AIデフォルト・パターンを減点）→ ⑧限定的修正 → 決定論的最終エンコード**。

## 3. 設計原則（kyberion の既存原則との整合）

1. **LLM はセマンティックブリーフとシーン設計を書く。スタイルリテラルはトークンから引く**（LAYERED_EXECUTION_PLAN の原則を維持。ただし「設計の自由度」をシーン構造・モーション選択まで拡張する）。
2. **検証ループは typed ops**（`core:transform` JS でも `system:exec` ラッパでもなく）。視覚批評は reasoning backend への委譲タスク。
3. **決定論とトレース**: 本家の決定論規則は kyberion の replayable pipeline 思想と同型。lint・批評・修正の各反復を Trace に残す。
4. **無言の劣化禁止**（AR-06 と同旨): フォールバック発動・批評不合格のまま納品は必ずユーザーへ表面化。

## 4. ワークストリーム

### MP-01: デザイン語彙の拡充（基盤・最優先）

`creative-design-resolver.ts` のトークンモデルを本家水準へ:

- **タイポグラフィ**: モジュラースケール（display/headline/title/body/label の5ロール＋surface別サイズ表）、ウェイトペア（コントラスト必須: 例 300/800)、heading≠body フォントの解禁と日本語ペアリング（DS-03 と接続）。
- **スペーシング/グリッド**: 4pt ベースのスペーシングトークン、surface 別セーフマージン（pptx: 0.5in、video: タイトルセーフ 5%）。
- **アンチ・モノカルチャー規則の宣言化**: 禁止フォント/配色パターン、最小サイズをトークン JSON（`knowledge/public/design-patterns/brand-tokens/` 配下）に「制約」として記述し、後述 MP-04 の批評ルーブリックが参照。
- native-pptx-engine が `resolveCreativeDesign` の射影を直接消費する接続（LE 計画の残課題）。

### MP-02: 動画オーサリングモデルの転換 — 固定コンパイラから「ガードレール付きシーン設計」へ

> **実装メモ(2026-07-20・更新)**: **DONE**。当初は視覚批評ループ(MP-04)が無いことを理由にシーンオーサリングを見送り PARTIAL としたが、MP-04 完了後に**統制ブロック語彙方式**で完遂した(自由記述 HTML ではなく、9種のブロック×5種のレイアウト×emphasis/column から LLM が構成を組む。決定論・テナント統制・注入安全性を保ったまま、配置と強調と動きが物語ごとに変わる)。以下は当時の判断記録。当初「シーン HTML の LLM オーサリング」と書いたが、実装では **DS-04 が確立した統制パターン(LLM は統制カタログの id を選ぶだけ・normalize で clamp・失敗時は既定へ縮退)をモーションへ拡張する形**を採った。自由記述 HTML を LLM に書かせる案は、出力を検分する手段(MP-04 の視覚批評ループ)が無い状態では品質を保証できず、決定論とテナント統制も担保できないため見送っている。MP-04 完了後に再評価する。

- **ビート設計工程の新設**: 固定 `BeatPlanEntry` テーブルによる流し込みを、reasoning backend への委譲タスク「beat-direction ブリーフ」（各ビートの尺=読了時間バジェット、モーション意図、視覚意図）に置換。ストーリーボードは④実装前の**レビューゲート**（run-shape でスキップ可）。
- **シーン HTML の LLM オーサリング**: `video-composition-compiler.ts` の固定シーンを「スキャフォールド＋ストックモーションライブラリ」に降格。LLM は MP-01 トークン（`--kb-*`）とモーションライブラリ（entrance 8種・ミッドシーン8種・ease カタログ）**のみ**を使ってシーン構造を組む。HeyGen の規約（`data-start`/`data-duration`、シーン窓の隙間なし、decorative は `.scene-content` 外）をそのまま採用。
- **hyperframes lint の取り込み**: `npx hyperframes lint` と決定論規則（random/clock/無限リピート禁止）を typed op `video:lint_composition` として preflight に組み込む。
- **フォールバックの表面化**: 静止画スライドショー降格時は成果物メタデータと納品メッセージに明示（AR-06 準拠）。
- 既存の固定コンパイラは「LLM 不使用の deterministic モード」として残す（後方互換・stub バックエンド用）。

### MP-03: PPTX レイアウトフィット — 「計測なき配置」の廃止

- **テキスト計測 op の新設**（typed op、`native-pptx-engine` 内）: フォントメトリクスbenchmark（日本語含む）で各要素の必要高を見積り、ボックスと照合。オーバーフロー時は (a) 自動リフロー（フォントサイズをスケール内で1段降格 / 行数でスライド分割 / ゾーン変更）、(b) 不能なら批評工程へ差し戻し。`Math.ceil(lines*0.55)` 型のヒューリスティック分割を全廃。
- **body-zone の拡充はしない**（6種のまま）。ゾーンを増やすのではなく、ゾーン内の配置をトークン化されたグリッド＋計測で決める。
- outline → render の間に `media:layout_fit` ステップを挿入（`pptx-produce-from-brief.json` フラグメント改修）。

### MP-04: 視覚QAループ — render → 批評 → 修正（動画・PPTX 共通）

> **実装メモ(2026-07-20・更新)**: **DONE**。当初 PARTIAL としていた3残件(マルチモーダル経路・ラスタライズ実写検証・SA-04 Task2)をすべて解消した。以下は当時の記録と、その後の解決内容。
>
> - **マルチモーダル経路が無い**: `reasoning-backend` はテキスト入力のみで、画像を渡す経路が全 backend に存在しない(`image_url`/base64 の実装ゼロ)。既定 critique をテキスト委譲にフォールバックさせると、**画像を見ずにファイルパス文字列だけを見て確信的な所見を返す**=捏造レビューになるため、意図的に未実装とし `skipped`(理由付き)を返す設計にした。実批評を有効化するには backend interface への画像入力チャネル追加(anthropic/claude-agent/codex-cli/copilot-acp の各実装)が必要で、これが MP-04 最大の未スコープ作業。
> - **実写未検証**: 本ホストに soffice/pdftoppm が無く、ラスタライズ経路は実行検証できていない(能力検出と降格経路のみ検証済み)。
> - **セキュリティ**: ラスタライズしたページ画像も機密のままなので、送信前に `validateReasoningEgress` を適用し deny 時は critique を呼ばない。confidential 素材の中間ファイルは mission-local ディレクトリ必須(`active/shared/` は path 由来で public tier と判定されるため、そこに書くと tier を格下げしてしまう)。`soffice`/`pdftoppm` は shell-command-policy の allowlist に **headless 限定**で追加。
> - **SA-04 の前提が未成立**: `secureFetch` の tier context(SA-04 Task2)は未実装で egress mode も `warn` のため、既存の egress ゲートは機密画像の流出を実際には止めない。本モジュール内のゲートが唯一の実効防御である点に注意。

本計画の核。Anthropic pptx skill / generator-evaluator ループの移植:

- **PPTX**: `soffice --headless --convert-to pdf` → `pdftoppm` → スライド画像を reasoning backend へ委譲し、ルーブリック（オーバーフロー・整列・コントラスト・余白・AIデフォルト減点・MP-01 制約違反）で批評 → 構造化された修正指示（`patchPptxParagraphs` 等の既存パッチ API で適用）。
- **動画**: `npx hyperframes snapshot` で各シーンの代表フレーム（開始・中間・終了）を静止画化 → 同様に批評 → タイミング/レイアウト限定の修正（「視ずに磨くな」原則: 修正はスナップショットを根拠に）。
- **反復上限と収束**: 最大3反復（本家は5-15だがコスト勘案で開始値3）、各反復を Trace に記録。不合格のまま上限到達時は「批評残課題付き」で納品し明示。
- 実装は typed ops（`media:visual_review`、`video:visual_review`）＋パイプラインフラグメント。soffice/pdftoppm 依存は onboarding の capability 検出に追加。

### MP-05: インテント→ゴールのフロー見直し（ライフサイクル③の強化）

HyperFrames のインテント層を kyberion のライフサイクルに対応付ける:

- **ブリーフのロック**: Alignment（③）でメディア案件は `BRIEF`（audience / objective / tone / brand 参照 / run-shape）を確定し、**「明示された決定」と「推定した決定」を区別して記録**。推定部分はユーザーが一目で覆せる形で提示。既存 `VideoContentBrief` / `document_outline_from_brief` の上流にこの契約を置く。
- **run-shape 判断の標準化**: ストーリーボードレビューの要否・視覚QA反復数・許容フォールバックを③で決め、パイプライン入力に含める（毎回の暗黙判断を排除）。
- **Review（⑤）での蒸留**: 視覚批評で繰り返し検出された失敗パターンを `knowledge/public/design-patterns/` の house-style（制約トークン）へ昇格するループを review フェーズの標準作業に追加（本家の「400トークンへの蒸留」に相当。KM-03 の昇格ガバナンスに接続）。

### MP-07: body-zone 語彙の拡充（非目標からの転換・2026-07-20 追加）

**診断**: semantic 語彙は11種以上あるのに `resolveBodyZoneLayout` は5種しかマッピングせず、**summary / contents / execution / signals / table / appendix / content をすべて `single_column` に潰していた**。配置は正しくても、どの内容でも同じ見た目になる構造的上限。

- **レンダラのデータ駆動化**: ゾーンを JSON の `regions` 宣言（`pos` はアンカー名＋オフセット、`fill`/`color` はテーマロール、`source` はテキスト選択子）から描画する汎用レンダラを新設。**ゾーン追加＝JSON追加**とし、アクチュエータへの分岐追加を禁じる。既存6ゾーンは実績があるため当面据え置き（移行は後続）。
- **新ゾーン**: `metrics_band`（数値主体）/ `comparison_two_col`（対比）/ `contents_index`（2カラム目次）/ `statement`（キーメッセージを大きく保持）/ `checklist_grid`（多数の短項目）/ `table_feature`（表＋前文）。
- **マッピング拡張**: コード側 `resolveBodyZoneLayout` と統制カタログ `media-design-systems/systems.json` の `body_zone_map` の両方を更新（後者が優先されるため両方必須）。
- **分類の修正**: 目次スライドが `semantic_type: 'summary'` とハードコードされ、エグゼクティブサマリと同一ゾーンに流れていた（2箇所）。目次は索引であり要約ではない。

### MP-06: 検証・受け入れ基準（dog-food）

- **ゴールデンブリーフ**: 同一ブリーフ3種（日本語重め・データ重め・ナラティブ重め）で動画＋PPTX を生成し、視覚QAルーブリックのスコアを改善前後で比較。evidence はミッション/パイプライン経由で採取（dog-food 規則）。
- **文字ズレ回帰テスト**: 日本語長文・箇条書き過多・表混在の3ケースで MP-03 計測 op がオーバーフローゼロを保証する hermetic テスト。
- **決定論テスト**: 同一入力2回レンダリングのフレームハッシュ一致（動画）、OOXML バイト一致（PPTX）。

## 5. フェーズ分けと依存関係

| フェーズ | 内容                                            | 依存                                               |
| -------- | ----------------------------------------------- | -------------------------------------------------- |
| P1       | MP-01（語彙拡充）＋ MP-03（レイアウトフィット） | なし。**文字ズレの直接原因を最短で解消**           |
| P2       | MP-04（視覚QAループ）                           | P1（批評ルーブリックが MP-01 制約を参照）          |
| P3       | MP-02（動画オーサリング転換）                   | MP-01, MP-04（シーン設計の品質保証に視覚QAが前提） |
| P4       | MP-05（インテントフロー）＋ MP-06（受け入れ）   | P1-P3 の器が揃ってから run-shape を意味づけ        |

各フェーズはミッション化（mission_controller 経由）し、1フェーズ=1ミッションで checkpoint を切る。

## 6. 非目標

- ~~body-zone レイアウトの種類追加（配置知能で解く。テンプレ増殖はしない）。~~
  **撤回(2026-07-20)**: この非目標は「計測を直さずにテンプレを増やして誤魔化す」ことを防ぐ意図で書いたもので、**文字ズレ(配置の正しさ)に対しては今も有効**だが、**表現力(視覚的多様性)を同じ軸で扱っていたのが誤り**だった。MP-03 で計測が入った今、ゾーン追加は修正の代替ではなく純粋な加算であり、新ゾーンも自動的に layout-fit を通る。ただし条件を付ける: **ゾーンは JSON の region 宣言で定義し、アクチュエータに分岐を増やさない**(ハードコード幾何の増殖こそが元の問題だったため)。→ MP-07 として実施。
- スタイルリテラル内蔵型プロトコルの新設（LAYERED_EXECUTION_PLAN の非目標を継承）。
- Remotion 等への render backend 乗り換え（hyperframes CLI 継続。`media-backend-registry` の抽象は維持）。
- 視覚QAの人間承認必須化(run-shape でユーザーが選ぶ。デフォルトは自動反復)。

## 7. 未確認事項・リスク

- 提示動画の「HyperFrames のみで制作」は未確認（§2 注記）。プロセス移植の妥当性には影響しない。
- `soffice`/`pdftoppm` はサンドボックス/環境依存 — onboarding capability 検出と approval-first の扱いが必要。
- 視覚批評は非 stub reasoning backend 必須（wisdom 系と同じ制約）。stub 時は MP-03 の決定論的計測のみでデグレード動作（その旨を表面化）。
- LLM シーンオーサリング(MP-02)はコスト増。run-shape で「テンプレモード/設計モード」を選択可能にして制御。
