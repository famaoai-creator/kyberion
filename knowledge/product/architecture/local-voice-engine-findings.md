---
title: Local Voice Engine Findings (Apple Silicon, 16 GB)
category: Architecture
tags: [voice, tts, stt, mlx, whisper, kokoro, qwen3-tts, measurement]
importance: 7
author: Devin
last_updated: 2026-10-13
---

# Local Voice Engine Findings

Measured on the same Apple Silicon 16 GB host as
`local-media-generation-hardware-findings`. All engines below are already
declared in `knowledge/product/governance/voice-engines/` and their tool
runtimes in `knowledge/product/governance/tool-runtimes/`; this document
supplies the empirical numbers that justify the registry.

## STT

| engine                             | model                                  | measured                     | memory          | notes                                                      |
| ---------------------------------- | -------------------------------------- | ---------------------------- | --------------- | ---------------------------------------------------------- |
| `mlx_whisper`                      | `mlx-community/whisper-large-v3-turbo` | **30 s audio → 8.0 s**       | ~1.5 GB weights | MLX; Japanese transcription verified on a sung vocal track |
| `faster_whisper` (existing bridge) | Systran int8, CPU                      | works; slower than MLX turbo | ~1-2 GB         | used by `vocal_align`; portable fallback                   |

The cached `whisper-large-v3-turbo-asr-fp16` repo is an ASR-fp16 variant used
by mlx-audio's `stt_model` default for clone-quality checks.

## TTS

| engine            | model                           | measured                                | peak memory    | notes                                                                                  |
| ----------------- | ------------------------------- | --------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `kokoro`          | `mlx-community/Kokoro-82M-4bit` | **4.9 s speech in 2.04 s** (RTF ~0.42x) | **1.41 GB**    | `jf_alpha` ja voice verified; needs `misaki[ja]` + `unidic-lite` (conflict note below) |
| `mlx_audio_qwen3` | `Qwen3-TTS-12Hz-1.7B-Base-8bit` | **6.2 s speech in 8.85 s** (RTF 0.71x)  | 6.58 GB        | ICL voice clone verified using a 5 s excerpt of an ACE-Step vocal as `ref_audio`       |
| `local_say`       | macOS `say`                     | instant, lowest quality                 | ~0             | universal default, keep                                                                |
| `pocket_tts`      | kyutai/pocket-tts               | —                                       | ~215 MB cached | en only; not retested here                                                             |

## Practical rules discovered

- **Kokoro Japanese needs `misaki[ja]` + `unidic-lite`, and `unidic` must not
  be installed empty.** fugashi resolves `unidic/dicdir` first when the
  `unidic` package is present; an unidic install without its dictionary
  download breaks MeCab init even when `unidic-lite` is available. Fix:
  `uv pip uninstall unidic` (keep `unidic-lite`).
- **Qwen3-TTS `Base` models have no preset voices.** Passing
  `voice='af_heart'` raises an error — Base models require `ref_audio` +
  `ref_text` for ICL cloning. A singing-vocal excerpt works as ref_audio, so
  narration can clone the generated singer.
- **Language codes differ per engine**: Kokoro ja pipeline is `lang_code='j'`
  (misaki), Qwen3-TTS uses `lang_code='ja'`. Bridge scripts already normalize
  this (`language_notes` fields).
- mlx-audio reports `Peak memory usage` per generation — cheap to harvest for
  the engine's cost profile.
- HF repos worth noting: `mlx-community/Kokoro-82M-{4,6,8}bit`-bf16 and
  `Qwen3-TTS-12Hz-1.7B-{Base,CustomVoice}-8bit` are ungated; pocket-tts ships
  `pocket-tts-without-voice-cloning` variant.

## Suggested engine priority (this hardware profile)

- **TTS quality (ja/en)**: `kokoro` (4-bit, ~1.4 GB, RTF 0.42x) > `local_say`
- **Voice cloning / persona narration**: `mlx_audio_qwen3` > `pocket_tts`
  (en only) > clone-unavailable engines
- **STT**: `mlx_whisper` (darwin+mlx) > `faster_whisper` (portable CPU)

Registry defaults stay `local_say`/`faster_whisper` for portability; the
quality upgrade path is resolved per-host via `resolveVoiceEngineForPlatform`
and `resolveMediaBackendForPlatform` (accelerators/memory-aware).

## Realtime conversation measurements (5 s utterance unless noted)

`realtime-voice-loop.ts` needs sub-second-ish STT and fast first-audio TTS to
keep the LISTENING→SPEAKING round-trip snappy on this host.

### STT per-turn latency (MLX, 5 s ja utterance)

| model                        | cold                       | notes                                                                          |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| whisper-tiny (mlx)           | **0.92 s**                 | lowest latency; rough ja output — usable as the loop's fast transcription tier |
| whisper-base (mlx)           | ~9 s (incl. download)      | mid tier                                                                       |
| whisper-small (mlx)          | ~21 s (incl. download)     | accurate but too heavy per-turn                                                |
| whisper-large-v3-turbo (mlx) | ~5.4 s (warm)              | best quality; fits eotHold + confirm passes, not every-chunk                   |
| parakeet-tdt-0.6b-v3 (mlx)   | 0.9 s but **empty output** | v3 covers European languages only — no ja. Not usable for this locale          |

Guideline: streaming/fast tier = whisper-tiny (barge-in confirmation, partial
gates), high-quality final pass = large-v3-turbo or faster-whisper small.

### TTS time-to-first-audio (MLX)

| engine                       | first audio                | full utterance       | peak    | realtime fit                                                                   |
| ---------------------------- | -------------------------- | -------------------- | ------- | ------------------------------------------------------------------------------ |
| kokoro-82M-4bit (`jf_alpha`) | **0.58 s**                 | 0.59 s               | 1.41 GB | strong — sentence-level TTFA well under 1 s                                    |
| qwen3-tts 0.6B stream bridge | —                          | streaming PCM chunks | low     | designed for this seam (`qwen3_tts_stream_bridge.py`, stdin text → stdout PCM) |
| qwen3-tts 1.7B ICL           | ~9 s total for 6.2 s audio | —                    | 6.58 GB | not a live engine; narration/clone jobs only                                   |

Recommended live stack on this host:
`ten_vad`/`silero_vad` (barge-in) → `whisper-tiny` fast turn + `large-v3-turbo`
final → `kokoro` (TTFA ~0.6 s) or `qwen3-0.6B` stream bridge for PCM piping.
