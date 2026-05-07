# Pipeline Fragments

このディレクトリには、複数のパイプラインで再利用可能な ADF (Agentic Data Format) のステップ群（Fragments）を配置します。

## 新規追加された Deterministic Fragments

### 1. `executive-report-patrol.json`
- **目的**: 複数サイトのダッシュボードを自動巡回し、データを収集・蓄積する。
- **パターン**: `CEO_SCENARIOS.md` の **Pattern D**（複数サイト横断）に対応。
- **主要操作**: `browser:goto`, `browser:snapshot`, `file:write`, `wisdom:knowledge_inject`

### 2. `governed-voice-narration.json`
- **目的**: プレゼンテーション資料に Governed Voice Stack を用いた音声ナレーションと動画プレビューを付与する。
- **拡張**: `CEO_SCENARIOS.md` の **Governed Stack 拡張**に対応。
- **主要操作**: `media:pptx_slide_text`, `voice:generate_narration_bulk`, `video:render_preview`

### 3. `security-incident-containment.json`
- **目的**: セキュリティインシデント発生時の証跡収集、承認ゲート、隔離実行、およびハッシュチェーンによる監査記録。
- **シナリオ**: `CEO_SCENARIOS.md` の **Scenario 9** に対応。
- **主要操作**: `system:collect_logs`, `blockchain:record_event`, `approval:request`

### 4. `browser-point-site-hop.json`
- **目的**: ポイントサイトを経由して特定のショッピングサイトへ遷移し、ポイント付与対象の状態を確立する。
- **主要操作**: `browser:goto`, `browser:fill_ref`, `browser:click_ref`

### 5. `browser-purchase-checkout.json`
- **目的**: カート確認、チェックアウト、承認ゲート、決済実行、領収書保存、ブロックチェーン記録。
- **主要操作**: `approval:request`, `browser:click_ref`, `blockchain:record_event`

### 6. `browser-travel-search-select.json`
- **目的**: 航空券や宿の検索、検索結果の抽出、指定条件に基づく最適案の推薦・選択。
- **主要操作**: `browser:fill_bulk`, `wisdom:recommend`, `browser:click_ref`

## 使用方法

メインのパイプライン JSON 内で、`wisdom:apply_fragment` 等の操作（またはオーケストレータによる展開）を通じて利用されます。

各 Fragment は `action: "pipeline"` と `steps[]` を持つ通常の Pipeline ADF 形状に寄せています。ただし一部の `op` は actuator 実装や fragment 展開層を前提にしたテンプレートです。実行前に `pnpm cli preview pipelines/fragments/<name>.json` 等で unresolved variable と実行可能性を確認してください。
