---
title: Voice Interface Protocol (VIP)
category: Orchestration
tags: [orchestration, voice, interface, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Voice Interface Protocol (VIP)

音声による対話を通じて、エコシステムの操作と意思決定を迅速化するためのプロトコル。

## 1. 音声対話の美学 (Voice Aesthetics)

- **簡潔さ (Brevity)**: 音声応答は、原則として 3フレーズ（約30秒以内）に収める。詳細なデータは「Chronos Mirror をご覧ください」と誘導する。
- **即応性 (Low Latency)**: ローカル LLM (Gemma) を活用し、思考の待ち時間を 1秒以内に抑える。
- **確認の徹底 (Confirmation)**: 破壊的な操作（ファイルの削除、高額APIの実行）は、必ず「実行してよろしいですか？」と音声で再確認する。

## 2. 技術スタック (The Sensory Stack)

| 機能            | 採用技術                 | 特徴                                            |
| :-------------- | :----------------------- | :---------------------------------------------- |
| **Ear (STT)**   | mlx-audio Whisper (Local) | Apple Silicon 最適化。オフライン高精度日本語認識。 |
| **Brain (LLM)** | Kyberion Reasoning Backend | `KYBERION_REASONING_BACKEND` で切替（claude-cli / gemini-cli / anthropic）。 |
| **Mouth (TTS)** | CosyVoice 2 / Fish Speech / Qwen3-TTS (mlx-audio) + macOS `say` fallback | ゼロショットクローン対応。Apache 2.0 ライセンス。Apple Silicon Metal 動作。 |
| **AudioBus**    | BlackHole 2ch + SwitchAudioSource | TTS 出力 → 仮想マイク入力 → ブラウザ → 会議のルーティング。 |

詳細セットアップ: `knowledge/public/voice/meeting-voice-proxy-setup.md`

## 3. 音声コマンドの拡張

- 「お疲れ様」→ `task_manager.js` の退勤処理を起動。
- 「今の状況は？」→ `PERFORMANCE_DASHBOARD` の要約を読み上げ。
- 「資料を作って」→ `Executive Reporting Maestro` を召喚。
- 「この音声を書き起こして」→ `transcribe-audio` / STT bridge を起動。
- 「ライブ音声で会話したい」→ `live-voice` / realtime voice conversation を起動。
- 「動画を生成して」→ `generate-video` / prompt-based video generation を起動。

### 実装済みスキル
- **voice-notifier**: CLI から直接音声を発生させる基本スキル。
  ```bash
  gemini run voice-notifier --text "任務を完了しました。" --voice "Kyoko"
  ```

### Related Media Intents

- `speak-with-my-voice`: local TTS / cloned-voice generation
- `transcribe-audio`: batch audio transcription
- `live-voice`: turn-based live conversation with STT and TTS

---

_Created: 2026-02-14 | Voice Interface Architect_
