---
title: Windows local model smoke evaluation on Ryzen AI Max+
kind: reference
scope: repository
authority: empirical
tags: [windows, local-models, ollama, qwen, coding, browser, documents]
importance: 7
author: Kyberion
last_updated: 2026-10-13
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [windows, ollama, local-llm]
status: active
---

# Windows local model smoke evaluation

## Host and runtime

Observed on Windows 11 Pro 10.0.26200 with an AMD Ryzen AI Max+ 395, Radeon 8060S, and 64 GiB RAM. Ollama 0.40.3 served the requests from localhost. The process listing showed 100% GPU use, a 32768-token active context, and the llama.cpp runner. Model metadata advertised 262144 context; use the observed runtime context when planning actual workloads.

## Installed model tags

The local Ollama tag inventory contained four tags and three distinct digests:

| Tag                | Digest                                                           | Parameters / quantization |                 Size | Tested                |
| ------------------ | ---------------------------------------------------------------- | ------------------------- | -------------------: | --------------------- |
| qwen3.8:27b-q4_K_M | 25b843619e944cd0ae6069f94ff4e5e26a16e109ccbc0a66a0f05979ed70098e | 27.3B, Q4_K_M             | 17,741,872,132 bytes | Yes                   |
| qwen3.8:27b        | aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813 | 27.3B, Q4_K_M             | 17,741,872,154 bytes | No                    |
| ornith:latest      | a75697c145891910e312c95e4a9fc1ccb8653e5ef543b23b0403a4665b82fd91 | 9.0B, Q4_K_M              |  5,629,110,568 bytes | Yes                   |
| ornith:9b          | a75697c145891910e312c95e4a9fc1ccb8653e5ef543b23b0403a4665b82fd91 | 9.0B, Q4_K_M              |  5,629,110,568 bytes | Same digest as latest |

Do not treat qwen3.8:27b and qwen3.8:27b-q4_K_M as aliases: they have different digests. The evidence below only covers qwen3.8:27b-q4_K_M.

## Matched smoke prompts

Each task/model pair was sampled once with temperature 0; code and document cases requested JSON and capped output at 256 tokens. Thinking was disabled.

| Task                    | Qwen 3.8 27B Q4_K_M                                                   | Ornith 9B Q4_K_M                                   |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| TypeScript add function | Valid JSON, 30 tokens, 22.519 s                                       | Valid JSON, 30 tokens, 7.445 s                     |
| Browser tool intent     | Selected open_browser_url for https://example.com; 29 tokens, 3.351 s | Same tool and URL; 29 tokens, 1.241 s              |
| Japanese short document | Valid JSON heading and summary; 72 tokens, 6.010 s                    | Valid JSON heading and summary; 66 tokens, 2.025 s |

Kyberion generateWithTools also returned report_test_result with status ok for both models. This confirms tool-call generation only. No browser was launched and no browser actuator was executed. These single samples do not establish a quality ranking or stable throughput.

An initial Qwen document attempt with thinking enabled reached the token limit and returned no visible content. Retrying with thinking disabled and JSON response mode succeeded.

## Kyberion route observation

The configured subagent route selected Ollama Qwen and reported ready. Its route policy had toolsEnabled false and an empty allowedTools list, although backend capability metadata reported tool calling. Model capability and route authorization are separate; enabling tool access requires an explicit route policy change.

## Runtime discovery

Ollama was available and used for the evaluation. vllm, llama-server, and llama-cli were not found on PATH. This PATH lookup does not establish that those runtimes are absent from other installation locations.

## Evidence

Detailed host inventory, model metadata, and matched smoke measurements are recorded in mission MSN-WINDOWS-LLM-EVAL-20261013. The measurements were transcribed from local Windows system details, Ollama /api/tags and process listing, direct chat responses, Kyberion tool-call generation, and reasoning configuration doctor/explain output.

## Multimedia evaluation (Windows, 2026-10-13)

Host: same Windows 11 Pro / Ryzen AI Max+ 395 / 64 GiB RAM. Added Ollama gemma4:e4b locally (7.5B, Q4_K_M, 6.6 GB, digest prefix dc35e8d9c606; Ollama 0.40.3). The model advertises text, image, and audio input capabilities. Results below are smoke checks on this host, not a quality benchmark.

| Modality / operation                    | Result                      | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image understanding                     | Pass, with a caveat         | pnpm kyberion see docs/assets/surfaces/computer-surface.jpg --describe --no-ocr --provider local_vlm --json routed to Ollama vision and correctly described the Japanese UI. The response was truncated mid-sentence.                                                                                                                                                                                                             |
| Audio understanding                     | Pass                        | Gemma 4 transcribed the Japanese TTS WAV through Ollama /api/chat in 7.3 s (170 prompt tokens, 18 output tokens); transcript matched the spoken sentence. This tests speech recognition from audio input, not music analysis.                                                                                                                                                                                                     |
| Video understanding                     | Partial / poor on this clip | pnpm kyberion watch active/shared/tmp/windows-multimedia-flower.mp4 --ocr-provider local_vlm --json parsed a 5.055 s H.264 clip (960×540, audio present) and sampled five frames. OCR output was mostly noise for the flower footage. Speech-to-text reported no transcript because every local backend returned empty text; the clip did not contain useful speech. This does not establish robust temporal scene understanding. |
| Image generation                        | Not available locally       | pnpm kyberion draw ... --dry-run --json found no runnable local image provider. The media-generation preflight found ComfyUI unavailable at 127.0.0.1:8188. Cloud providers were not enabled. No image was generated.                                                                                                                                                                                                             |
| Lyric text generation                   | Pass                        | Gemma 4 generated four original Japanese lyric lines via local Ollama chat (36 output tokens).                                                                                                                                                                                                                                                                                                                                    |
| Speech generation from generated lyrics | Pass                        | pnpm kyberion speak ... --lang ja --json produced a 496,640-byte WAV with the local Windows local_say / Kyoko voice. This is spoken narration, not singing.                                                                                                                                                                                                                                                                       |
| Song / music generation                 | Not completed               | The Windows MusicGen/MLX backend is Apple Silicon only. Stable Audio 3 is the available local CLI route, but this host has no HF_TOKEN / HUGGING_FACE_HUB_TOKEN; its model weights are gated. No music artifact was produced.                                                                                                                                                                                                     |

The generated media and downloaded CC0 video fixture were kept under ignored active/shared/tmp/. The generated lyric output demonstrates a local text-to-speech composition path, but this test did not generate sung vocals or instrumental music.
