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
| **Ear (STT)**   | OpenAI Whisper (Local)   | オフラインで動作。高精度な日本語認識。          |
| **Brain (LLM)** | Gemma 2 (Ollama)         | ローカル実行。高速かつ日本語に強い。            |
| **Mouth (TTS)** | macOS `say` / ElevenLabs | `say` は即時性、ElevenLabs は感情表現に優れる。 |

## 3. 音声コマンドの拡張

- 「お疲れ様」→ `task_manager.js` の退勤処理を起動。
- 「今の状況は？」→ `PERFORMANCE_DASHBOARD` の要約を読み上げ。
- 「資料を作って」→ `Executive Reporting Maestro` を召喚。

### 実装済みスキル
- **voice-notifier**: CLI から直接音声を発生させる基本スキル。
  ```bash
  gemini run voice-notifier --text "任務を完了しました。" --voice "Kyoko"
  ```

---

_Created: 2026-02-14 | Voice Interface Architect_
