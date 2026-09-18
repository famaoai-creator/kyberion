---
title: Tool Runtime Abstraction
category: Architecture
tags: [runtime, package-manager, uvx, npx, venv, install, policy]
importance: 7
last_updated: 2026-09-16
---

# Tool Runtime Abstraction

Kyberion does not treat `uvx`, `npx`, `pipx`, `brew`, or `uv` as arbitrary shell trivia. They are runtime mechanisms that must be governed by a shared policy.

## Core Idea

The user-facing intent is about the tool outcome:

- trial a tool without installing it first
- approve and install a tool into a governed environment
- re-run an already installed tool
- pin a tool version and its managed location

The runtime layer resolves the concrete backend and path handling.

Canonical placement rules for these runtimes live in [`../governance/dependency-placement-policy.md`](../governance/dependency-placement-policy.md).

## Layers

1. `tool-runtime-policy`
   - Governs default runtime modes, managed roots, and approval requirements.
   - Example: `KYBERION_TOOL_RUNTIME_POLICY_PATH`.

2. `tool-runtime-registry`
   - Declares per-tool launch plans, install plans, and managed environment roots.
   - First governed entry: `mflux` for Apple Silicon local FLUX generation.
   - The registry can also be queried as an inventory to show whether each tool is in `trial`, `approved_install`, `installed`, or `pinned` lifecycle state.

3. `tool-runtime-state`
   - Records whether a tool has been installed or pinned, and where it lives.
   - State is stored under the managed runtime root in `active/shared/runtime/`, with per-tool state in `tool-runtimes/<tool>/state.json`.

## Example: `mflux`

For local FLUX image generation, the runtime can:

- run trial execution through `uvx`
- install into a managed Python tool environment via `uv tool install`
- re-run the installed tool via `uv tool run`

The image generation bridge asks the runtime layer for the launch plan instead of hardcoding `uvx`.
Higher-level surfaces can call `listToolRuntimeInventory()` to present the current lifecycle of all governed tools in one place.

## Example: local music CLIs

Music generation follows the same pattern as `mflux`, via `music-generation-bridge`:

- `musicgen_mlx` — Apple Silicon MusicGen (`uvx --from mlx-audiocraft musicgen-mlx`; env: `KYBERION_MUSICGEN_*`)
- `stable_audio_3` — Stable Audio 3 small-music from upstream git (`uv tool install git+https://github.com/Stability-AI/stable-audio-3.git`; env: `KYBERION_STABLE_AUDIO_*`; gated HF weights need `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`)

Media backends `media-generation.musicgen_mlx` and `media-generation.stable_audio_3_small_music` resolve through tool-runtime probes; ComfyUI remains the default `media.music` backend.

## Other Governed Examples

The registry is intentionally not limited to Python tools:

- `playwright`
  - Node / browser runtime example
  - Trial probe through `npx playwright --version`
  - Managed browser bootstrap through the runtime layer or `pnpm env:bootstrap --manifest meeting-participation-runtime`
- `ffmpeg`
  - System media toolkit example
  - Trial probe through `ffmpeg -version`
  - Install through `brew install ffmpeg`
- `sox`
  - Audio toolkit example
  - Trial probe through `sox --version`
  - Install through `brew install sox`
- `tesseract`
  - OCR toolkit example
  - Trial probe through `tesseract --version`
  - Install through `brew install tesseract`
- `mlx_audio`
  - Apple Silicon TTS engine dependency example
  - Trial probe through `python3 -c "import mlx_audio"`
  - Install through the managed runtime registry into `active/shared/runtime/tool-runtimes/mlx-audio/`
- `mlx_whisper`
  - Apple Silicon STT engine dependency example
  - Trial probe through `python3 -c "import mlx_whisper"`
  - Install through the managed runtime registry into `active/shared/runtime/tool-runtimes/mlx-whisper/`

## Design Rule

Never bind user intent directly to a package manager.
Bind intent to the artifact or tool outcome, then let the runtime layer decide whether the tool should be tried, installed, reused, or pinned.
