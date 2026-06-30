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

### 7. `google-meet-join-button.json`
- **目的**: Google Meet の参加画面を開き、名前を入力して join / ask-to-join ボタンを押す。
- **主要操作**: `browser:goto`, `browser:fill_ref`, `browser:click_ref`

### 8. `microsoft-teams-join-button.json`
- **目的**: Microsoft Teams の join-a-meeting 画面を開き、会議 ID / パスコードを入力して join ボタンを押す。
- **主要操作**: `browser:goto`, `browser:fill_ref`, `browser:click_ref`

### 9. `google-meet-join-self-contained.json`
- **目的**: ブラウザ起動の前段を含めて Google Meet の join ボタン押下までを一括で実行する。
- **主要操作**: `core:include`, `browser:goto`, `browser:fill_ref`, `browser:click_ref`

### 10. `microsoft-teams-join-self-contained.json`
- **目的**: ブラウザ起動の前段を含めて Microsoft Teams の join ボタン押下までを一括で実行する。
- **主要操作**: `core:include`, `browser:goto`, `browser:fill_ref`, `browser:click_ref`

### 11. `html-web-preview.json`
- **目的**: brief から self-contained HTML を生成し、ファイルに書き出して OS 既定のハンドラで即表示する。
- **主要操作**: `reasoning:synthesize`, `code:write_artifact`, `system:open_file`
- **用途**: Web の説明資料、概念ページ、操作デモの local preview。

### 12. `runtime-preflight.json`
- **目的**: 渡された shell preflight command を実行し、標準の `preflight_result` を返す共通ラッパー。
- **主要操作**: `system:shell`

### 13. `voice-runtime-preflight.json`
- **目的**: voice service と voice bridge / sample 前提をまとめて確認する。
- **主要操作**: `core:include`, `system:shell`

### 14. `music-video-preflight.json`
- **目的**: media-generation service とローカル media runtime の前提をまとめて確認する。
- **主要操作**: `core:include`, `system:shell`

### 15. `browser-runtime-preflight.json`
- **目的**: browser / Playwright runtime の前提をまとめて確認する。
- **主要操作**: `core:include`, `system:shell`

### 16. `meeting-runtime-preflight.json`
- **目的**: meeting service と browser runtime の前提をまとめて確認する。
- **主要操作**: `core:include`, `system:shell`

### 17. `live-voice-preflight.json`
- **目的**: live voice と meeting runtime の前提をまとめて確認する。
- **主要操作**: `core:include`, `system:shell`

### 18. `ui-voice-browser-preflight.json`
- **目的**: UI / voice / browser / meeting のスモーク実行前に必要条件をまとめて確認する。
- **主要操作**: `core:include`, `system:shell`

## 使用方法

メインのパイプライン JSON 内で、`wisdom:apply_fragment` 等の操作（またはオーケストレータによる展開）を通じて利用されます。

各 Fragment は `action: "pipeline"` と `steps[]` を持つ通常の Pipeline ADF 形状に寄せています。ただし一部の `op` は actuator 実装や fragment 展開層を前提にしたテンプレートです。実行前に `pnpm cli preview pipelines/fragments/<name>.json` 等で unresolved variable と実行可能性を確認してください。
