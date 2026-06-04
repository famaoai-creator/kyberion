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
| **Mouth (TTS)** | CosyVoice 2 / Fish Speech / Qwen3-TTS (mlx-audio) + macOS `say` fallback | ゼロショットクローン対応。Apache 2.0 ライセンス。Apple Silicon Metal 動作。`mlx_audio` / `mlx_whisper` の runtime 依存は tool-runtime で管理する。 |
| **VirtualDeviceInventoryBridge** | system_profiler / ffmpeg / pactl scan | Scans host-visible audio/camera candidates before the bridge chooses a concrete backend. |
| **VirtualAudioInputRecordingBridge** | ffmpeg avfoundation / sox default-input capture | Selects a concrete microphone input and records a short sample for voice capture and verification. |
| **VirtualInputDeviceInventoryBridge** | hidutil / libinput / xinput scan | Scans host-visible keyboard/mouse candidates before OS automation chooses a concrete input route. |
| **ScreenDisplayInventoryBridge** | system_profiler display scan / xrandr | Scans host-visible display candidates before screenshot and screen-recording choose a concrete display index. |
| **VirtualAudioDeviceBridge** | BlackHole 2ch + SwitchAudioSource / PulseAudio routing | Owns device hookup / routing and selects the concrete audio bus. |
| **VirtualAudioOutputPlaybackBridge** | macOS default-output switching + afplay | Temporarily routes a test tone or TTS artifact through each selected speaker so the output path can be verified. |
| **AudioBus**    | BlackHole 2ch + SwitchAudioSource | PCM transport only. The bridge owns device hookup / routing; the bus moves audio between TTS, browser, and meeting surfaces. |
| **ScreenCaptureBridge** | screencapture / import / focused-window capture | Owns screenshot and screen-frame capture. It is the screen-side analogue to the camera bridge. |
| **ScreenRecordingBridge** | screen-frame capture + mp4 archive wrapper | Packages captured screen frames into mp4 without interpreting them. |
| **VideoFrameBus** | camera / screen frame loopback / transport | Frame transport only. The capture bridge owns device hookup / routing; the bus moves frames to downstream consumers. |
| **VideoFrameArchive** | ffmpeg mp4 encode/decode | Format boundary only. Converts frame streams to mp4 and back without adding meaning. |
| **VirtualCameraInjectionBridge** | mp4/frame replay or OS-backed virtual camera sink | Owns the upstream path that accepts mp4 or frame streams and either replays them through the archive boundary or injects them into a concrete virtual camera sink. |
| **VirtualMediaDeviceControlBridge** | inventory bridge + audio/camera bridge composition | Selects existing devices at runtime and returns host provisioning plans for add/remove flows. |

詳細セットアップ: `knowledge/product/voice/meeting-voice-proxy-setup.md`

Boundary note: microphone capture, voice playback, speaker routing, camera frame
transport, and meeting entry are separate concerns. `voice-actuator`
handles synthesis / playback / profiles, `SpeechToTextBridge` handles
transcription, `AudioBus` handles PCM transport, `VideoFrameBus`
handles camera/screen-frame transport, `VideoFrameArchive` handles mp4
format conversion, `ScreenCaptureBridge` owns the downstream screen capture
boundary, `ScreenRecordingBridge` owns the screen-recording wrapper,
`VirtualCameraInjectionBridge` owns the upstream camera
replay/injection boundary, `VirtualAudioDeviceBridge` owns the
virtual-device hookup / bus selection, `VirtualAudioOutputPlaybackBridge`
handles the speaker-verification tone path and TTS artifact playback path,
`VirtualAudioInputRecordingBridge` handles microphone sample capture and
verification path, `VirtualCameraBridge` owns camera capture / frame
piping, `ScreenDisplayInventoryBridge` exposes display indices for screen
capture / recording, and `meeting-browser-driver` handles the web-meeting join
backend. `meeting-actuator` surfaces that backend as a `join_backend`
label in its bridge/status payloads.

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
