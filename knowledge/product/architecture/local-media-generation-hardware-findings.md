---
title: Local Media Generation Hardware Findings (Apple Silicon, 16 GB)
category: Architecture
tags: [media-generation, quantization, gguf, mlx, mps, accelerator, backend-selection]
importance: 8
author: Devin
last_updated: 2026-10-13
---

# Local Media Generation Hardware Findings

Measured on an Apple Silicon Mac (16 GB unified memory, MPS), ComfyUI on
`:8189` (custom nodes: ComfyUI-GGUF), `/Volumes/data/comfy2/.venv`.

These measurements back the `accelerators` and `min_memory_gb` fields on
`MediaBackendRecord` in `knowledge/product/governance/media-backends/`.

## Hard rules discovered

- **FP8 diffusion-model weights do not run on MPS.** ComfyUI gates quantized
  matmul behind `supports_fp8_compute` (CUDA-family only); fp8 weights on MPS
  fail at `KSampler` with `Undefined type Float8_e4m3fn`. Backends that carry
  fp8 model weights must declare `accelerators: ["cuda"]` (or another
  fp8-capable accelerator) — `"mps"` is wrong for them.
- **FP8 text-encoders are fine everywhere.** `t5xxl_fp8_e4m3fn.safetensors`
  loads and runs on MPS because TE weights are cast to the compute dtype, not
  run through quantized matmul. `ltx-i2v-fp8` is therefore still valid on MPS.
- **GGUF works on MPS** via `ComfyUI-GGUF` (`UnetLoaderGGUF`, `CLIPLoaderGGUF`)
  because it dequantizes on load. It does not need the fp8 compute path, so it
  is the community-quantization escape hatch for this hardware.
- **`acestep-dit` GGUF is not loadable by ComfyUI-GGUF** — it targets
  `acestep.cpp` (GGML/C++, Metal/CUDA/CPU) instead, which is a separate
  runtime.
- **ACE-Step LM quantization floor:** Q4_K_M on the 4B lyric LM "breaks audio
  codes" (upstream note); use the 0.6B/1.7B LM at Q8_0 or the 4B at >=Q5_K_M.

## Measured results

### Image (`generate_image`)

| backend                     | model                                             | resident                        | time/image      | notes                                       |
| --------------------------- | ------------------------------------------------- | ------------------------------- | --------------- | ------------------------------------------- |
| `comfyui` (current default) | sd_xl_turbo fp16                                  | ~7 GB                           | ~15 s           | fastest; low-mid quality, twin-subject risk |
| `mflux` (local_flux)        | madroid/flux.1-schnell-mflux-4bit                 | ~4 GB weights, 13.7 GB MLX peak | ~95 s (4 steps) | high quality; single CLI, no ComfyUI        |
| `comfyui.flux-gguf`         | flux1-schnell-Q4_0.gguf + t5xxl_fp8 + clip_l + ae | ~12 GB                          | ~143 s          | high quality via ComfyUI-GGUF               |

### Video (`generate_video`, i2v)

| backend                           | model                           | resident      | time/clip                    | notes                             |
| --------------------------------- | ------------------------------- | ------------- | ---------------------------- | --------------------------------- |
| `comfyui.ltx-i2v-fp8`             | ltx-2b fp16 + t5xxl fp8         | ~13.6 GB      | ~4 min @65f/768x432          | proven in mv-proto                |
| `comfyui.wan-i2v-gguf`            | wan2.2-ti2v-5b Q4_K_M + umt5 Q4 | ~8.4 GB       | ~6.7 min @49f/640x360/8st    | hero-shot quality; motion correct |
| wan Q8_0 GGUF                     | 832x480/81f/20st                | ~11.9 GB      | ~37 min                      | end-of-clip overexposure seen     |
| wan fp8 (meimeilook/Kijai)        | —                               | —             | fails on MPS                 | fp8 matmul unsupported            |
| wan fp16                          | 10 GB                           | ~18 GB + swap | aborted >50 min              | impractical at 16 GB              |
| `hyperframes_cli` (video compose) | HTML → mp4                      | light         | **30 s render / 30 s video** | deterministic, no diffusion       |

### Music (`generate_music`)

| backend                               | model                                       | resident         | time/30 s song                   | notes                        |
| ------------------------------------- | ------------------------------------------- | ---------------- | -------------------------------- | ---------------------------- |
| `comfyui.music` (ACE-Step turbo fp16) | 4.8 GB DiT + ~5 GB qwen TE + VAE            | ~11 GB           | ~2-3 min                         | proven (song.mp3)            |
| `acestep-cpp`                         | turbo Q4_K_M + LM 0.6B Q8 + Qwen3-Emb + VAE | **3.1 GB total** | **~37 s** (LM 12 s + synth 25 s) | Metal build verified         |
| `musicgen_mlx`                        | musicgen-mlx                                | ~4 GB            | ~30 s/30 s                       | instrumental only, no vocals |
| acestep GGUF via ComfyUI-GGUF         | acestep-dit arch                            | —                | fails                            | unsupported arch             |

## Backend priority (this hardware profile)

- **image**: `z-image-turbo` via mflux (peak 4.4 GB) or `local_flux` (mflux FLUX) → `comfyui` (sdxl-turbo) → cloud fallbacks
- **video**: `hyperframes_cli` for composition/slideshow; `comfyui.ltx-i2v(-fp8)` for i2v; `comfyui.wan-i2v-gguf` as quality upgrade path
- **music**: `acestep-cpp` → `comfyui.music` → `musicgen_mlx` (instrumental)

## Operational notes

- Gated repos (`black-forest-labs/FLUX.1-*`) need `HF_TOKEN`; community mirrors
  (`madroid/flux.1-schnell-mflux-4bit`, `city96/FLUX.1-schnell-gguf`) are
  ungated and sufficient.
- ComfyUI server must run **without** `--disable-all-custom-nodes` for GGUF
  loaders.
- `pnpm` `minimumReleaseAge` blocked `hyperframes@0.8.150` (published <2 days);
  the repo pins `^0.8.147`.
- mflux installs as a Python package (`mflux`); a stale venv under
  `/Volumes/data/kyberion/.venv` held an older install with a broken shebang —
  binary relocations break pinned shebangs.
