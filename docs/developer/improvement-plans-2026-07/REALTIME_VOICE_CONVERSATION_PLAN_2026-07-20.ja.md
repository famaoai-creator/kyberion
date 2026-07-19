# リアルタイム音声対話 (TTS/STT/VAD) 改善計画

- 作成日: 2026-07-20
- ステータス: **Phase 0〜4 実装済 (2026-07-20)**
  - Phase 0: `libs/core/vad-turn-recorder.ts` (VAD endpoint 駆動発話区切り + ノイズフロア較正 + `VadTurnSegmenter` として共通化)、`libs/core/pcm-wav.ts`
  - Phase 1: `segmented-voice-playback.ts` (文単位合成×先行再生パイプライン)、`audio-playback.ts` (停止可能な PlaybackHandle)、actuator `--serve` 常駐モード (`cli-utils.ts`) + `actuator-serve-client.ts` (ウォームクライアント)、streaming STT のターン内接続 (partial は発話中に処理、endpoint で final、バッチ STT フォールバック)
  - Phase 2: `realtime-voice-loop.ts` (LISTENING→THINKING→SPEAKING 状態機械、barge-in はオプトイン `--barge-in`: 閾値×2 + 250ms デバウンス、割り込み音声は次ターン先頭として保持)。`audio-tee.ts` を coordinator から共通抽出
  - Phase 3: `vad-registry.ts` (`KYBERION_VAD=energy|silero`、fail-soft で energy に明示degrade)、`silero-vad-bridge.ts` + `silero_vad_bridge.py` (NDJSON サブプロセス契約、失敗時 EnergyVad フォールバック)
  - Phase 4: 録音同意ゲート (`--mission`、coordinator と同じ fail-closed 契約)、TraceContext イベント + ターン毎レイテンシ計測 (stt/llm/first-audio/speak)、`live-voice-preflight` にマイク/再生バイナリ検査、`voice-health-check` に silero ブリッジ検査、手順書更新、hermetic E2E (`realtime-voice-loop.test.ts`)
  - 残課題 (今後): AEC (エコーキャンセル) 導入評価、LLM トークンストリーミング→文単位 TTS 直結、会議側 coordinator への barge-in 部品還元
- 対象: `scripts/run_realtime_voice_conversation.ts` / `libs/core/realtime-voice-conversation.ts` とその周辺の音声基盤
- 関連: [IP-08 エラーハンドリング規律](./IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) · [E2E-01 会議→価値](./E2E-01_MEETING_TO_VALUE.ja.md)

## 1. ゴール

現在の「固定秒数録音 → バッチ STT → LLM → 一括 TTS → 再生」というターン制音声会話を、
**VAD による発話自動検出・ストリーミング処理・barge-in(割り込み)を備えたリアルタイム対話ループ**へ段階的に引き上げる。

体感目標 (受け入れ基準):

| 指標                               | 現状 (推定)                                        | 目標                                         |
| ---------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| 発話終了検出                       | なし (固定 8 秒録音)                               | endpoint_ms + 150ms 以内に発話終了を検出     |
| 応答開始まで (time-to-first-audio) | 10 秒超 (録音残時間 + バッチ STT + LLM + 全文 TTS) | 2 秒以内 (ローカル TTS 時)                   |
| barge-in 停止レイテンシ            | 不可能                                             | ユーザー発話開始から 300ms 以内に再生停止    |
| 無音時の誤発話区切り               | —                                                  | 環境ノイズ下で誤 endpoint 率を計測可能にする |

## 2. 現状の正確な把握 (調査結果)

### 2.1 既にある資産

| 資産                                                                                         | 場所                                                                                      | 状態                                                                                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| VAD インターフェース + RMS 実装 (`EnergyVad`)                                                | `libs/core/voice-activity-detector.ts`                                                    | 実装済・テスト済。endpoint 検出 (既定 700ms 無音)                                                   |
| マイクキャプチャ (ffmpeg avfoundation / arecord)                                             | `libs/core/mic-capture.ts`                                                                | 実装済。`AudioChunk` 非同期イテレータ、`command` オーバーライドでフィクスチャ再生テスト可能         |
| mic → VAD → セグメント WAV → バッチ STT の参照実装                                           | `libs/core/in-room-minutes-recorder.ts`                                                   | 実装済 (議事録用途)。録音同意ゲート (fail-closed) 付き                                              |
| **ストリーミング会話ループ (audio bus → tee → streaming STT + VAD → agent → streaming TTS)** | `libs/core/meeting-participation-coordinator.ts`                                          | 実装済 (会議参加用)。ただし VAD は診断用に流しているだけで、発話タイミング制御・barge-in には未接続 |
| ストリーミング STT 契約 (stub + `KYBERION_STT_COMMAND` シェルアダプタ、NDJSON partial/final) | `libs/core/streaming-stt-bridge.ts` / `shell-streaming-stt-bridge.ts`                     | 実装済。実バックエンド (whisper.cpp stream 等) は環境変数で差し込み                                 |
| ストリーミング TTS 契約 (stub + gemini + シェルアダプタ)                                     | `libs/core/streaming-tts-bridge.ts` / `shell-streaming-tts-bridge.ts`                     | 契約は実装済。ただし Gemini 実装は全文集約後に一括合成しており実質非ストリーミング                  |
| 文単位チャンク分割                                                                           | `libs/core/voice-text-chunking.ts`                                                        | 実装済 (voice-actuator のレンダリングで使用)                                                        |
| ターン制会話本体                                                                             | `libs/core/realtime-voice-conversation.ts` + `scripts/run_realtime_voice_conversation.ts` | 実装済。セッション永続化・音声プロファイル/同意ゲート・presence timeline 連携あり                   |

### 2.2 リアルタイム化を阻んでいるギャップ

1. **固定秒数録音**: `run_realtime_voice_conversation.ts --interactive` は Python `record_bridge.py` で `--record-seconds` (既定 8 秒) だけ録音して終了。VAD 未使用。短い発話では待たされ、長い発話では切れる。
2. **バッチ STT**: 録音完了後に `speech-to-text-bridge` (ファイル一括) を呼ぶ。streaming-stt-bridge は会議側でしか使われていない。
3. **一括 TTS + サブプロセス起動コスト**: 応答全文を `voice-actuator` の node プロセスを毎ターン spawn して合成 (`safeExec`, timeout 120s)。文単位の先行再生なし。エンジンのモデルロードも毎回発生。
4. **barge-in 不可能**: 再生は actuator 内部で完結し、呼び出し側に停止ハンドルがない。再生中はマイク監視もしていない。
5. **エコー問題が未整理**: 再生中にマイクを開けばアシスタント自身の声で VAD が発火する。半二重ゲート/閾値調整/AEC の方針が未定義。
6. **EnergyVad の閾値が固定**: `rms_threshold: 800` 固定でノイズフロア適応がない。ファンノイズ環境で誤動作する (agy 調査の指摘どおり)。
7. **会議ループとローカル会話ループの二重実装リスク**: coordinator に既にほぼ同型のループがあるのに、ローカル会話を別実装で伸ばすと将来分岐する。

## 3. 方針

**「meeting-participation-coordinator のストリーミングループ形をローカルマイク会話に持ち込み、共通の双方向会話ループへ収斂させる」** ことを軸にする。ゼロから作らない。

- VAD 駆動のターン取得は `in-room-minutes-recorder.ts` のパターン (連続バッファ + endpoint フラッシュ) を流用する。
- STT/TTS は既存の streaming bridge 契約 (NDJSON / AsyncIterable) をそのまま使い、実バックエンドを差し込む。
- barge-in は「再生停止ハンドル」+「再生中 VAD 監視」の 2 部品として汎用化し、会議側にも将来還元する。

## 4. フェーズ計画

### Phase 0 — VAD 駆動ターン取得 (最小のリアルタイム化)

`run_realtime_voice_conversation.ts --interactive` の録音を固定秒数から VAD endpoint 駆動へ置き換える。

- `record_bridge.py` 依存を外し、`startMicCapture()` + `EnergyVad` で「発話開始検出 → endpoint で WAV フラッシュ → 既存 `runRealtimeVoiceConversationTurn()` へ」とする。
- `--record-seconds` は「最大発話長 (セーフティキャップ)」として意味を変えて残す (minutes recorder の `maxSegmentSeconds` と同型)。
- **ノイズフロア較正**: セッション開始時の先頭 ~500ms の RMS を測り `rms_threshold = max(既定値, k × ノイズフロア)` を設定。`--vad-threshold` / `--vad-endpoint-ms` の CLI 上書きも追加。
- テスト: `mic-capture` の `command` オーバーライドで PCM フィクスチャを再生し、endpoint 分割が決定的に再現できることを hermetic に検証 (`in-room-minutes-recorder.test.ts` と同じ手法)。

成果物: 「話し終えたら勝手にターンが進む」体験。アーキテクチャ変更なしで最大の体感改善。

### Phase 1 — レイテンシ削減 (ストリーミング化・ターン内)

1. **文単位 TTS 先行再生**: 応答全文を一括合成せず、`voice-text-chunking.ts` で文分割し、チャンク N を再生中にチャンク N+1 を合成するパイプラインにする。時間差再生は `streaming-tts-bridge` 契約 (`AsyncIterable<string>` → `AsyncIterable<AudioChunk>`) 上で実装し、actuator 一括呼び出しから移行する。
2. **voice-actuator の常駐化**: 毎ターンの node プロセス spawn + エンジン初期化をなくすため、actuator に常駐 (server/daemon) モードまたはウォームプロセス再利用を追加する。`peer_conversation_server.ts` の常駐パターンを参考にする。
3. **ストリーミング STT の接続**: 発話中に `ShellStreamingSpeechToTextBridge` (`KYBERION_STT_COMMAND`: whisper.cpp stream / mlx 系) で partial を流し、endpoint で final 確定のみ行う。バッチ STT はフォールバックとして残す (streaming 未設定環境)。
4. LLM 応答は当面 `delegateTask` 一括のままとし、プロンプトで短い発話向け応答を強制 (既に実装済)。バックエンドがトークンストリーミングに対応した段階で 1 の文単位 TTS に直結する。

成果物: time-to-first-audio 2 秒以内 (ローカル TTS)。各ターンで `listen_ms / stt_ms / llm_ms / tts_first_chunk_ms` をトレースに記録し、目標値を計測可能にする。

### Phase 2 — barge-in と全二重ループ

新規 `libs/core/realtime-voice-loop.ts` (状態機械: `IDLE → LISTENING → THINKING → SPEAKING → LISTENING`) を追加し、CLI をこれに載せ替える。

1. **再生停止ハンドル**: 再生 (afplay / 再生子プロセス) を `PlaybackHandle { stop(): Promise<void> }` として抽象化。`native-tts.ts` の timeout kill と同じ機構を外部公開する形。TTS 合成チェーンにもキャンセルトークンを通す (合成途中の破棄)。
2. **SPEAKING 中のマイク監視**: マイクは常時開き、`teeInbound` (coordinator 実装を共通化して流用) で VAD へ分岐。SPEAKING 中に `speaking: true` が **闾値引き上げ + 最小継続時間 (例 250ms) のデバウンス**付きで検出されたら、再生停止 → バッファリセット → LISTENING へ遷移。
3. **エコー対策の段階導入**:
   - 既定は**半二重** (SPEAKING 中はマイク入力を VAD 判定のみに使い、STT へ流さない。barge-in 判定閾値はエコーの実測 RMS より高く設定)。
   - barge-in はオプトイン (`--barge-in`)。ヘッドセット利用を推奨として文書化。
   - AEC (エコーキャンセル) は本フェーズではスコープ外とし、Phase 3 のニューラル VAD 導入後に再評価。
4. 会議側 (`meeting-participation-coordinator.ts`) の「VAD は診断のみ」状態も、この共通部品 (endpoint 待ち発話・barge-in) を使う形に还元する (別 PR)。

成果物: エージェント発話中に話し始めると 300ms 以内に止まり、こちらのターンになる。

### Phase 3 — VAD 品質向上 (ニューラル VAD)

- `VoiceActivityDetector` インターフェースを満たす **Silero VAD ブリッジ**を追加: `libs/actuators/voice-actuator/scripts/` に ONNX 推論の Python ブリッジ (既存 `mlx_audio_stt_bridge.py` 等と同じサブプロセス NDJSON 契約) を置き、TS 側は `shell-streaming-stt-bridge` と同型のアダプタで包む。
- 選択は registry + 環境変数 (`KYBERION_VAD=energy|silero`)。未設定・依存欠如時は `EnergyVad` へフォールバック (fail-open ではなく明示ログ)。
- `EnergyVad` は「安価な前段ゲート」(明らかな無音は Silero に送らない) として残す。
- 評価: ノイズ入りフィクスチャ (ファンノイズ + 発話) を用意し、energy/silero の誤 endpoint 率をテストで比較可能にする。

### Phase 4 — ガバナンス・製品化仕上げ

- **同意ゲート**: ローカルマイク会話にも `checkMeetingParticipationConsent(purpose=recording)` 相当の fail-closed ゲートを適用 (minutes recorder と同一線)。
- **トレース**: coordinator と同様の `trace.addEvent` (turn 開始/endpoint/barge-in/レイテンシ内訳) を realtime-voice-loop に実装。
- **プリフライト**: `pipelines/fragments/live-voice-preflight.json` / `voice-health-check.json` に「streaming STT 設定有無・マイク probe・VAD バックエンド」を追加。
- **ドキュメント**: `knowledge/public/procedures/media/realtime-voice-conversation.md` を新モード (VAD 自動ターン、barge-in、必要環境変数) で更新。
- **テスト**: フィクスチャ再生によるループ全体の hermetic E2E (stub STT/TTS + 決定的 PCM) を `scripts/run_realtime_voice_conversation.test.ts` 系に追加。

## 5. 実施順序と粒度

各フェーズは独立にマージ可能。推奨順: **Phase 0 → 1 → 2 → 3 → 4** (0 と 1-2 の間で体感確認を挟む)。
Phase 0 は 1 PR 規模。Phase 1 は 3 項目を別 PR に分割 (文単位 TTS / actuator 常駐 / streaming STT)。
Phase 2 は新モジュール + CLI 載せ替えで 1〜2 PR。ミッションゲート条件 (再実行性・複数成果物) を満たすため、着手時はミッションを起票し本計画を紐付ける。

## 6. リスクと対応

| リスク                                              | 対応                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| エコーで barge-in が誤発火し会話が壊れる            | 既定半二重 + オプトイン、デバウンス、閾値をエコー実測から較正                                           |
| streaming STT 実バックエンドの環境差 (mac/linux/CI) | 契約は NDJSON シェルアダプタで固定し、CI は stub + フィクスチャのみ。実バックエンドはプリフライトで検出 |
| actuator 常駐化による状態リーク                     | 常駐モードはターン間で明示リセット、既存の 1-shot モードを維持しフォールバック可能に                    |
| EnergyVad 閾値較正の環境依存                        | 較正値・採用閾値をトレースへ記録し、失敗時に再現材料を残す                                              |
| coordinator との二重実装                            | Phase 2 で `teeInbound`/endpoint 待ち/barge-in を共通モジュール化し、会議側も同部品へ寄せる             |
