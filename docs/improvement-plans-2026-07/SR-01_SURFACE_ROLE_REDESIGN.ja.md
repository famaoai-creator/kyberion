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
