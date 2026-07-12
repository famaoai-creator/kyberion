# SR-01: サーフェス役割再設計 — 秘書・相棒・管制塔・監査モニタ・手元ミラー

> 優先度: P0(operator UX) / 規模: L / 依存: E2E-04, DS-01, SU-02, SU-03 / 関連: E2E-01(会議)

## 背景と課題

surface 層の役割は文書(`surface-responsibility-model.md`、`ceo-ux.md`)にはあったが実装が追いつかず、(1) CEO秘書に相当するサーフェスが未実装、(2) presence-studio と chronos の役割が重複、(3) 介入ボタン・成果物 verdict が未配線(見えるが押せない)、(4) 会議出席が browser-playwright のみ、マイクからの自動議事録の入口がなかった。

## ゴール

1. 5つのUIサーフェスに1役割ずつ: **concierge=CEO秘書 / presence-studio=相棒 / chronos=管制塔 / operator-surface=監査モニタ / computer-surface=手元ミラー**。役割は `knowledge/product/governance/surface-roles.json` を正とし、各画面ヘッダに明記。
2. 見えるものは押せる(SU-02/SU-03 の配線完了)。
3. マイク録音 → 自動議事録(consent ゲート付き)。
4. 非ブラウザの会議出席(同席モード)。

## 実装状況 (2026-07-06) — 完了

- **Phase 0**: operator-surface を root tsconfig から除外(chronos と同扱い。Next アプリは自前 tsconfig/bundler 解決で検査)→ **root `pnpm typecheck` が本ブランチで初めて 0 エラー**。`libs/core/surface-mutation-guard.ts` に framework 非依存の変更ガードを抽出(operator-surface の no-write 契約は不変)。dangling な avatar-studio スクリプトを削除。
- **Phase 1**: `surface-roles.json` + 契約テスト `scripts/check_surface_roles.test.ts`(役割定義・dir 実在・ヘッダに tagline 表示・read-only 宣言を固定)。全サーフェスのヘッダに役割バッジ。`docs/SURFACES.md` を5役割表に刷新、`surface-responsibility-model.md` に §3.3b/3.3c と5列の責務表。
- **Phase 2 (SU-02/SU-03)**: `A2UIRenderer` に `onAction` を追加し `kb-intervention-panel` / `kb-artifact-tile` のクリックを実配線(approval_id → `/api/intelligence approval_decision`、mission_id → `intervention_respond`、成果物 → mission-asset を開く)。plan-preview の確認事項はクリックで依頼文に回答欄を追記。`DeliverableInboxStatus` に `rejected`/`changes_requested` + `verdict_note`/`reviewed_by` を追加し、chronos の deliverable-review が共有インボックス(entries.jsonl)へ verdict を同期。
- **Phase 3 (concierge 新設)**: `presence/displays/concierge`(Next 15、port 3050、`active-surfaces.json` 登録済み)。データ層 `libs/core/ceo-surface-summary.ts`(`buildCeoSurfaceSummary` — ceo-ux.md の4ペイン+デイリーブリーフィングへ写像、内部用語を出さない契約テスト付き)。API: GET /api/summary・/api/theme(`createConciergeWebThemePack`)、POST /api/approvals/[id](`decideApprovalRequest` as sovereign_concierge)、POST /api/outcomes/[id](verdict)。UI はです・ます調(「本日はご承認待ちが◯件ございます」)。
- **Phase 4 (相棒化)**: presence-studio に `GET /api/design-tokens.css`(`createCompanionWebThemePack` → --kb-\* vars、DS-01 の face 配線をクローズ)+「できること」カード群(議事録/メール/ブラウザ/承認/タスク)。ヘッダに「相棒 — いっしょに作業するワークベンチ」。
- **Phase 5 (マイク→議事録)**: `libs/core/mic-capture.ts`(ffmpeg avfoundation / arecord、テストは command 差し替え)+ `in-room-minutes-recorder.ts`(voice-consent purpose=recording をフェイルクローズ → EnergyVad 区切り → セグメント WAV を evidence へ → バッチ STT → transcript.md → stop() で `pipelines/meeting-followup.json` 実行)。CLI `pnpm minutes:record --mission <ID>`。presence-studio に「会議を記録」ボタン+SSE ライブ文字起こし。STT は既定 stub(sidecar)、実運用は `KYBERION_STT_COMMAND` / WhisperKit(`service-presets/whisper.json` 参照)。
- **Phase 6 (同席モード)**: `MeetingPlatform` に `in_room` を追加、`validateMeetingTarget` は `room://local` を許可。`libs/core/in-room-meeting-driver.ts` — audioInput=マイク、audioOutput=afplay/aplay、発話中はキャプチャ一時停止(簡易エコー抑制)。`meeting_participate --driver in-room`(--meeting-url 不要)。coordinator/同意/STT/議事録の下流は無変更。`zoom-sdk` / `recall-ai` は将来ドライバ(レジストリのシームのみ)。

## テスト

surface-mutation-guard(5)/ surface-roles 契約(4)/ deliverable-inbox 拡張(2)/ ceo-surface-summary(3)/ concierge 契約(3)/ mic-capture(4)/ in-room-minutes-recorder(2)/ in-room-meeting-driver(4)+ 会議 dry-run 回帰 133 + operator-surface 契約 12。

## 残余(スコープ外)

- zoom-sdk / recall-ai ボットドライバ、ストリーミング STT 議事録、話者分離(diarization)
- 共有 React コンポーネントライブラリ、presence-studio のフレームワーク刷新
- DS-02 テナントブランディング全面展開、DS-05 a11y 監査、SU-03 のアプリ内プレビュー/バージョンギャラリー
- macOS マイク権限(TCC)は初回実行時に手動許可が必要(meeting_preflight で ffmpeg 検査は追加済み検討 → 未実施)

## 実装メモ 追記 (2026-07-07) — モデル振り分け・LLMゲート・成果物品質監査

- **①タスク重み→モデル振り分け**: `ReasoningCallOptions.model_tier`(fast|standard|deep)を追加。workitem dispatch が `task_model_hint`(phase_kind/risk/scope 由来)を委譲呼び出しへ伝搬し、claude-cli backend が fast→haiku / standard→sonnet / deep→opus に `--model` でマップ(`resolveClaudeModelForTier`、テスト付き)。環境変数はバックエンド系統の選択のみに後退。
- **②LLMゲートチェック**: gate-engine に `llm_review` check kind を追加(成果物+判定基準→ backend.prompt → JSON verdict。stub 時はフェイルクローズ、`allow_stub: true` で advisory)。カタログの DECK/RESEARCH/ANALYSIS 各レビューゲートに追加(advisory 既定)。
- **③成果物品質監査(提案書PPTX)**: 機械ゲートは通過していた v1 デッキを LLM ゲート(claude sonnet 実審査)が**差し戻し** — 検出: 目次スライド重複、タイトル3重連結、英語スケルトン見出し混入、Office既定色残存。手動監査と完全一致。
- **アクチュエータ監査**: パイプライントレースで media ops(brief_to_design_protocol → pptx_render)の使用を確認。バグ根本は `brief_to_design_protocol` の目次生成(storyline ステップ除去・language=ja でも再現)→ **メディアアクチュエータのバックログ**(再現: proposal-brief 8枚 → 10枚出力、slide2/3 重複)。
- **副次修正**: `system:read_file` は SA-03 で常時 UNTRUSTED ラップされるため、構造化ブリーフの読込は `system:read_json` を使用(fragment 修正済み)。evidence の非統制書き換えがガバナンスに検知されることも確認(正しい挙動)。

## 実装メモ 追記2 (2026-07-07)

- `plan-tasks --refresh-catalog` 追加: カタログから再解決(永続 phase_specs を無視)し、**task_id 一致でタスク status を引き継ぐ**(進捗を失わない再計画)。修正過程で「未分類ミッションの再解決時に既定 code_change が mission_type ヒントを遮蔽し別テンプレートに化ける」バグを発見・修正。
- カタログ v1.3.0: **default_tasks を持つ全36フェーズに exit ゲートを付与**(evidence_exists 既定)。`check:workflow-catalog-refs` に「タスクを持つフェーズは exit_gate 必須」ルールを追加し再発防止。実ミッション(契約案件)で redline フェーズの REDLINE_DONE 通過→タスク完了化を実証。

## 実装メモ 追記3 (2026-07-07) — 可視化ダッシュボード群(V1-V3)

- `libs/core/agent-activity-board.ts`: work items+mission state から「エージェント×現在タスク×ブロッカー(blocked/依存待ち/レビュー待ち/未割当)」を集約(テナントフィルタ対応、テスト付き)。
- chronos: `GET /api/agent-activity`(?tenant=)+ `GET/POST /api/workitems`(看板の状態遷移は updateWorkItem 統制API)。ヘッダの「エージェント/看板」トグルで Activity Board(エージェント別サマリ+ブロッカーチップ)と5列看板を表示。実データ(aurora契約案件のエージェント5作業)で表示確認済み。
- concierge: `/setup` ページ + `GET /api/setup` — オンボーディング進捗(推論バックエンド/5サーフェスの有効・ポート)と拡張設定の読み取りビュー(モデル振り分け表・主要コマンド)。
