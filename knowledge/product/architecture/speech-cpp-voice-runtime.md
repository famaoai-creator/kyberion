---
title: speech.cpp as a Local Voice Runtime — Integration
kind: reference
scope: repository
authority: reference
phase: [alignment, execution]
tags: [voice, tts, asr, speech-cpp, tool-runtime, service-runtime]
owner: ecosystem_architect
last_updated: 2026-11-02
---

# speech.cpp as a Local Voice Runtime — Integration

[speech.cpp](https://github.com/nyosegawa/speech.cpp) runs TTS, ASR, VAD,
diarization and enhancement in C++ on ggml (Metal / Vulkan / CPU). The
runtime is **MIT**; model weights keep their upstream licences. Kyberion
invokes it as an external process — never vendors or links `libspeech`.

## Install

Governed tool-runtime `speech_cpp` (checksum-pinned zip, 0.10.1):

```bash
pnpm tool:setup -- --tool speech_cpp --apply
# → active/shared/runtime/tool-runtimes/speech_cpp/bin/speech (+ libspeech)
```

Resolve with `resolveSpeechCppBin()` (`KYBERION_SPEECH_CPP_BIN` first).
Release assets: darwin-arm64 (Metal), linux-x64 (CPU pin), win32-x64
(Vulkan). No darwin-x64 / linux-arm64 in v0.10.1.

Models download on first use into the OS cache (`~/Library/Caches/speech.cpp`
or `~/.cache/speech.cpp`), not into the managed env.

## Batch paths (default)

| Task | Path                                         | Engine / bridge                                                       |
| ---- | -------------------------------------------- | --------------------------------------------------------------------- |
| TTS  | `speech tts MODEL --voice … -o out.wav TEXT` | voice engine `speech_cpp` (`tts_adapter_id: speech_cpp`)              |
| ASR  | `speech asr MODEL audio.wav`                 | `installSpeechCppSpeechToTextBridgeIfAvailable` → bridge `speech_cpp` |

Defaults: `qwen3-tts-0.6b` / `qwen3-asr-0.6b` (override with
`KYBERION_SPEECH_CPP_TTS_MODEL` / `KYBERION_SPEECH_CPP_ASR_MODEL`). Voices:
`ryan` (en) / `ono_anna` (ja) when unset.

This is a cross-platform alternative to the MLX Python bridges
(`qwen3_tts_06b_custom_voice`, `irodori_tts`, `mlx_whisper`) — not a
replacement; pick by platform and privacy/latency purpose on
`voice-tts-engine`.

## HTTP / voice-hub

```bash
speech serve qwen3-tts-0.6b qwen3-asr-0.6b --host 127.0.0.1 --port 8095
```

Service-runtime `speech_cpp` probes `GET /health`. Base URL:
`KYBERION_SPEECH_CPP_URL` (default `http://127.0.0.1:8095`). The same URL
is accepted as a voice-hub STT server when `VOICE_HUB_STT_BASE_URL` is
unset (OpenAI `POST /v1/audio/transcriptions`).

Opt-in sidecar: `KYBERION_SPEECH_CPP_AUTOSTART=1` may spawn `speech serve`
on loopback when `/health` is down (default **off** — first model fetch
is large). `KYBERION_SPEECH_CPP_SERVE_MODELS` overrides the model list
(`-` / `none` = empty serve).

## Realtime conversation

speech.cpp covers streaming TTS PCM, live ASR, VAD and OpenAI Realtime
**transcription** websockets. Turn-taking and the LLM remain Kyberion’s
`realtime-voice-loop` / Presence path — wire speech.cpp as the ear/mouth,
not as the conversational agent.

## Licence notes

Runtime MIT. Prefer Apache/MIT catalog models for product defaults.
Drama 3 / some Irodori variants carry extra ethical or commercial terms —
see upstream README before enabling them in a tenant path.
