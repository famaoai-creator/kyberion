# 実行レイヤリング計画(LE-01〜05): pipeline / typed ops / デザインシステムの3層分離

> **作成日**: 2026-07-15
> **起点**: 「pipeline 経由と scripts/generate_all_objects_layout_sample.ts 経由で PPTX のデザインバランスが異なる」というオペレータ指摘。調査の結果、個別バグではなく**層の混線**(ガバナンス層・ロジック記述層・デザイン決定層が互いの責務を持ち合っている)という構造問題と診断した。
> **位置づけ**: AR-02(op レジストリ)・AR-08(カタログ監査)・DS-01(正準トークン)・HN-03(workflow-as-code)・E2E-02(creative-design-resolver)の**完了済み成果を接続する**計画。新規機構の発明ではなく、既存資産の未接続の縫い目を埋める。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)。

## 1. 診断(2026-07-15 調査の要約)

### 1.1 PPTX デザイン乖離の根本原因

両経路とも最終レンダラーは同一(`generateNativePptx()`, `libs/core/src/native-pptx-engine/engine.ts:17`)。乖離はすべて上流の「デフォルト補完層」の違い:

| 経路                                                        | デフォルト補完                                                                                        | 結果                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| スクリプト(`scripts/generate_all_objects_layout_sample.ts`) | ローカルヘルパー `txt()`/`shape()`/`line()`(:41,:56,:64)が Yu Gothic 14pt/12pt・gray 線を全要素に注入 | 省略キーも一貫                                                                                                                                    |
| pipeline(`media:pptx_render` → snapshot JSON)               | 補完層なし。省略キーは engine フォールバックへ                                                        | fontSize **18pt**(`builders.ts:244`)、フォント **Inter/Noto Sans JP**(`design-fonts.ts:90,110`)、線色なし → **描画されない**(`builders.ts:25-30`) |
| brief 駆動 LLM 経路(media-actuator)                         | 独自の第3のロジック(`index.ts:515-516`, `media-document-helpers.ts:126-369`)                          | さらに別のバランス                                                                                                                                |

つまり**デザイントークンが3〜4重管理**され、単一のカスケードが存在しない。`resolveCreativeDesign()`(`libs/core/creative-design-resolver.ts`, E2E-02 の設計解決単一入口)は存在するが、**native-pptx-engine が消費していない**。

### 1.2 scripts/ と pipelines/ の重複の実態

- scripts/ 約185本の大半は正当(CI ゲート26本・codegen 10本・デーモン・対話 CLI・mission 制御機構)。
- 真の問題は逆向き: **32本の pipeline が `system:exec dist/scripts/*.js` を呼ぶだけの薄いラッパー**(12本はスクリプトと1:1同名)。ロジックが TS に逃げる理由は一貫している — 動的コレクションのループ+累積状態、型付き `@agent/core` API 呼び出し、「見せかけ成功」への防御的検証(`scripts/campaign_suite.ts:46-58`)。
- ADF 側の摩擦: 任意ロジックは `core:transform` の **JSON 文字列内 JS**のみ、条件 DSL は固定8演算子(`libs/core/src/logic-utils.ts:132-161`)、スキーマは `params` 任意キー許容で typo が実行時まで沈黙(`pipeline-adf.schema.json:60,70`)。
- AR-08 の裏付け: 77本中75本は事実上未実行、静的検証通過分の約半分が実行時失敗していた。

## 2. 目標アーキテクチャ: 各層に得意なものだけ

```
Layer 3: Pipeline (JSON ADF) — ガバナンス・トレース・リプレイの「封筒」
   宣言的配線のみ。データ駆動 foreach とシナリオ分岐は OK。
   状態駆動ループ・計算・結果検証は持たない。
Layer 2: Typed Ops (TypeScript) — 決定論的ロジックの正本
   型付き入出力契約を持つ op。in-process 呼び出しでトレース・budget・
   ガードレールがステップ内部まで届く。
Layer 1: Design System (TypeScript) — デザイン決定の単一正本
   resolveCreativeDesign + デフォルトカスケード。全経路が同じ補完を通る。
   LLM はセマンティックブリーフを書く。スタイルリテラルは書かない。
```

使い分けの判定基準(AGENTS.md §2 に転記済み):

| 性質                          | 実現手段                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| 決定論的 × 再実行される       | pipeline(typed ops を配線)                                                              |
| 決定論的 × 一回きり           | script / scratch。2回目が見えたら typed op 化                                           |
| モデル判断が必要              | `reasoning:*` / `wisdom:*` にセマンティックブリーフ。凍結 ADF・スタイルリテラルにしない |
| デーモン・対話 CLI・CI ゲート | 永久に script                                                                           |

pipeline 内ループの判定: **データ駆動の反復**(既知リストに同一処理)は配線として OK、**状態駆動のループ**(条件成立まで累積・判断)は op 内へ。ブラウザ自動化の待機/リトライが op(actuator)の意味論に含まれるのと同じ原則(`browser-interaction-helpers.ts:71-216`, `browser-actuator/src/index.ts:294-330` が既に実装例)。

## 3. 実装計画

### LE-01: PPTX デザインデフォルトカスケード(P0 / S〜M)

**内容**: `libs/core/src/native-pptx-engine/design-cascade.ts` を新設し、`PptxDesignProtocol.designDefaults`(opt-in)を追加。`generateNativePptx()` の semantic reconstruction 入口で、スタイルキーが省略された要素に一貫したデフォルトを補完する。

- text 要素: fontFamily(theme フォント → `resolveFontFamilyPair`)、fontSize 14、color(テーマ text)
- テキストを持つ shape 要素: 同上、fontSize 12
- line 要素: line 色(muted)、lineWidth 1
- 明示値は常に優先。raw/image/chart/smartart は触らない。rawParts モードは対象外。
- `designDefaults: true`(組み込み値)または object(個別上書き)。**未指定なら完全に従来挙動**(golden 互換)。

**受入条件**: (1) designDefaults 未指定で出力バイト不変(既存テスト緑)。(2) 省略キーを持つ protocol に `designDefaults: true` で 18pt/Inter フォールバック・線消失が発生しない。(3) `pipelines/fragments/masterclass_design_protocol.json` が opt-in し、pipeline 経由の出力がスクリプト経由とバランス一致。

**担当モデル**: sonnet(パターン確立)。

### LE-02: レイアウトプリミティブの engine 側移植(P1 / M)

**内容**: `generate_all_objects_layout_sample.ts` のヘルパー(`sectionHeader`/`footer`/パレット `C`)を engine 側のレイアウトプリミティブとして正本化し、スクリプトを消費者に書き換える。media-actuator の brief 経路(`classifyRenderSemantic` 系)も同じプリミティブを参照するよう統合。テナントテーマは `resolveCreativeDesign({surface:'pptx', tenantSlug})` から `designDefaults` へ射影する変換を media-actuator に追加。

**受入条件**: パレット・レイアウト定数の定義箇所が1箇所。スクリプト・snapshot 経路・brief 経路の3経路が同一プリミティブを参照。

**担当モデル**: sonnet → 横展開 haiku。依存: LE-01。

### LE-03: script ラッパー pipeline の typed op 化(P1 / M〜L)

**内容**: `system:exec dist/scripts/X.js` パターンの公式後継として、型付き入出力契約(AR-03 の per-op 契約)を持つ in-process op を整備する。第1弾は reconcile 3本(`reconcile_config_fallbacks` / `reconcile_unclassified_errors` / `reconcile_unhandled_intents`)。スクリプト本体のロジックを op 関数として export し、CLI は薄い殻として残す(後方互換)。pipeline は `system:exec` でなく op を直接呼ぶ。

**効果**: トレース span・budget・エラー分類がロジック内部まで届く。exit code 詐称(字面成功)は出力スキーマ検証で構造的に解決。`core:transform` JS-in-string の利用理由を除去。

**受入条件**: 3本の pipeline から `system:exec` が消え、op 呼び出しに置換。出力契約の検証テストあり。AR-06(silent no-op 撲滅)と整合。

**担当モデル**: sonnet(1本目)→ haiku(横展開)。依存: AR-02(済)、AR-03。

### LE-04: 使い分け基準の正本化と導線(P1 / S)

**内容**: §2 の判定基準を AGENTS.md §2 Defaults に追記(本計画で実施済み)。`pipelines/README.md` に「pipeline に書いてよいロジック/いけないロジック」の節を追加し、`core:transform` に長い script 文字列を書く前に typed op 化を促す lint(adf-guardrails への警告ルール)を追加。

**受入条件**: AGENTS.md・pipelines/README.md に判定基準が載り、guardrails が `core:transform` の script 長超過(例: 200文字)に警告を出す。

**担当モデル**: haiku。

### LE-05: pipeline コーパス常設静的テスト(P1 / S〜M)

**内容**: AR-08 の積み残し。`tests/pipeline-adf-contract.test.ts` を vital-check 単体から **pipelines/ + fragments/ 全数**の schema+guardrails 検証へ拡大。`pipeline-adf.schema.json` の step を `additionalProperties: false` 方向へ段階的に締める(まず警告、次に enforce)。`media:pipeline` に埋め込まれた v1 形式ステップの盲点(AR-08 指摘)も再帰検証対象に含める。

**受入条件**: 全 pipeline JSON が CI で静的検証される。既知の意図的例外は明示 allowlist。

**担当モデル**: sonnet。依存: AR-08(済)。

## 4. 実施順序

```
LE-01 (即時・本計画で着手) → LE-02
LE-05 (独立・並行可)
LE-04 (独立・並行可、AGENTS.md 分は実施済み)
LE-03 (AR-03 の契約形式が固まり次第)
```

## 4.1 実施記録(2026-07-15)

**LE-01〜05 すべて同日実装完了**(詳細・検証エビデンスは [STATUS.ja.md](./STATUS.ja.md) の LE 節を正とする)。特記事項:

- LE-02 のスクリプト移行は、リファクタ前後の PPTX 出力が**全 zip エントリでバイト同一**であることを機械検証した(カスケードの `color` 補完を text 要素限定に修正する発見が1件)。
- LE-03 の実機検証で、**public-tier 自動修復が旧 script 経路でも authority 未付与により一度も動作していなかった**潜在バグを発見・修正(専用 authority role + `withExecutionContext`)。「pipeline がラッパーだとロジック内部の失敗が見えない」という本計画の診断を裏付ける実例。
- LE-05 の全数検証は初回実行で `voice-read-text.json` の v1 残骸を即検出した(監査の常設化が機能する実証)。

**同日追補(残作業の完遂)**:

- **スキーマ硬化(LE-05 残)**: step / トップレベルとも `additionalProperties: false` 化(`^_` 注釈と `comment` は許容、機能キー `knowledge_scope`/`env`/`session_id` は型・スキーマ両方に正式宣言)。適用範囲は pipelines/ + fragments/ + pipeline-templates/(263ファイル、常設テスト化)+ テナント/personal の一括掃引。硬化初回で `role: "apply"` という type/role 混同の実バグ2件を検出・修正。
- **op 化バッチ2(LE-03 横展開)**: `report-ops.ts` で cost_report / audit_verify / summarize_memory_promotion_queue / summarize_task_model_routing を op 化し、weekly-review と audit-verify-daily を完全 in-process 化。残ラッパーは「exec 維持が正しいもの」(mission_controller 不変条件・デーモン・CI ゲート・サブパイプライン起動)と「今後の op 化候補」(campaign_suite・mesh_delivery_driver・action_item_reminders・run_baseline_check)に分類済み — 詳細は STATUS の LE-03 行。

## 5. 非目標

- pipeline スキーマへの汎用式言語・ループ強化の追加(ロジックは Layer 2 に置く方針のため、逆方向)。
- 既存 masterclass snapshot のような「スタイル全量インライン protocol」の新規作成(LE-01 以降はアンチパターン。theme + semantic brief + カスケードで表現する)。
- scripts/ カテゴリ (b)(d)(CI・codegen・デーモン・mission 機構)の pipeline 化。
