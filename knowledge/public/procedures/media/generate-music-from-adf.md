---
title: 'Procedure: Generate Music From ADF'
last_updated: 2026-10-05
---

# Procedure: Generate Music From ADF

## 1. Goal

Generate a governed music artifact from a human-readable `music-generation-adf` contract instead of submitting a raw ComfyUI workflow.

## 2. Dependencies

- **Actuator**: `media-generation-actuator`
- **Default runtime**: local ComfyUI with ACE-Step models available
- **Lightweight local alternatives** (no ComfyUI):
  - `media-generation.musicgen_mlx` — Apple Silicon MusicGen via `mlx-audiocraft` (`KYBERION_MUSICGEN_*`)
  - `media-generation.musicgen_audiogen` — Apple Silicon MusicGen mono/stereo/melody variants via `mlx-audiocraft` successor `mlx-audiogen` (`KYBERION_MUSAUDIOGEN_*`; `KYBERION_MUSAUDIOGEN_MODEL` maps to a registry variant auto-downloaded as `--weights-dir`, explicit `KYBERION_MUSAUDIOGEN_WEIGHTS_DIR` wins)
  - `media-generation.chatmusician_mlx` — ChatMusician ABC composition via `mlx-lm`, rendered with `abcmidi` + `fluid-synth` and a `.sf2` SoundFont (`KYBERION_CHATMUSICIAN_*`; select with `purpose: compose` or a named `backend_id`)
  - `media-generation.stable_audio_3_small_music` — Stable Audio 3 small-music via git/`uv` (`KYBERION_STABLE_AUDIO_*`; gated HF weights need `HF_TOKEN`)
- **Vocals**: all local CLI backends above are instrumental-only. `params.vocals: true` (with optional `params.lyrics`) is accepted by the actuator but currently always fails closed with an actionable error naming the SongGeneration-MLX future path — both on auto-selection and on explicit `backend_id` naming — because no vocal-capable provider is registered yet.
- **Preflight**: `pnpm service:preflight -- --service media-generation` for ComfyUI; local CLI backends use tool-runtime trial/install
- **Schema**: [`music-generation-adf.schema.json`](../../../product/schemas/music-generation-adf.schema.json)

## 3. Contract Shape

`music-generation-adf` is the stable public interface.

- `style`: genre, mood, vocal traits
- `composition`: duration, BPM, key, structure
- `lyrics`: provided or instrumental mode
- `arrangement`: instrument and mix hints
- `engine`: backend profile and model overrides (`engine.backend_id` selects Comfy vs local CLI)
- `output`: filename prefix, governed target path, polling behavior

For ComfyUI, the actuator compiles this contract into an ACE-Step workflow. For local CLI backends, the ADF is treated as a semantic brief (prompt + duration) and routed through `music-generation-bridge`.

### Local CLI install

```bash
# MusicGen / MLX (darwin arm64)
uv tool install mlx-audiocraft
# or trial: uvx --from mlx-audiocraft musicgen-mlx "calm piano, no vocals" -d 10 -o /tmp/out.wav

# MusicGen variants: mono/stereo/melody (darwin arm64)
uv tool install mlx-audiogen
# or trial: uvx --from mlx-audiogen mlx-audiogen --model musicgen \
#   --prompt "wide stereo pad, no vocals" --seconds 10 --output /tmp/out.wav
# variant follows converted weights: mlx-audiogen-convert --model facebook/musicgen-stereo-medium \
#   --output ./converted/stereo-medium  (+ KYBERION_MUSAUDIOGEN_WEIGHTS_DIR)

# ChatMusician ABC composition (darwin arm64; needs abcmidi + fluid-synth + a .sf2)
uv tool install mlx-lm && brew install abcmidi fluid-synth
# KYBERION_CHATMUSICIAN_SOUNDFONT=/path/to/FluidR3_GM.sf2
# or trial: uvx --from mlx-lm mlx_lm.generate --model m-a-p/ChatMusician --prompt "..." --max-tokens 1024

# Stable Audio 3 small-music (CPU/MPS; accept HF license + set HF_TOKEN)
uv tool install git+https://github.com/Stability-AI/stable-audio-3.git
# or trial: uvx --from git+https://github.com/Stability-AI/stable-audio-3.git \
#   stable-audio --model small-music -p "lo-fi beat" --duration 30 -o /tmp/out.wav
```

Direct actuator examples:

- [`direct-musicgen-mlx.json`](../../../../libs/actuators/media-generation-actuator/examples/direct-musicgen-mlx.json)
- [`direct-musicgen-audiogen.json`](../../../../libs/actuators/media-generation-actuator/examples/direct-musicgen-audiogen.json)
- [`direct-chatmusician-mlx.json`](../../../../libs/actuators/media-generation-actuator/examples/direct-chatmusician-mlx.json)
- [`direct-stable-audio-3-small-music.json`](../../../../libs/actuators/media-generation-actuator/examples/direct-stable-audio-3-small-music.json)

## 4. Execution

Example input:

- [`music-adf-anniversary-country-ja.json`](../../../../libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json)
- [`submit-music-generation-job.json`](../../../../libs/actuators/media-generation-actuator/examples/submit-music-generation-job.json)
- [`music-generation-schedule-anniversary.json`](../../../../libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json)

Run:

```bash
pnpm service:preflight -- --service media-generation
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json
```

Long-running job submission:

```bash
pnpm service:preflight -- --service media-generation
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/submit-music-generation-job.json
```

Follow-up job actions:

- `get_generation_job`
- `wait_generation_job`
- `collect_generation_artifact`

Recurring schedule contract:

- `generation-schedule` expresses when a job template should be submitted
- `generation-job` expresses one concrete run of that template
- scheduler runtime is intentionally separate from the media actuator

Scheduler runtime:

```bash
pnpm generation:schedule --action register --input libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json
pnpm generation:schedule --action tick
```

If the latest job has completed successfully and `delivery_policy.latest_alias_path` is set, the scheduler updates that alias copy during `tick`.

Orchestrator-ready bundle:

- [`music-generation-pipeline-bundle.json`](../../../../libs/actuators/orchestrator-actuator/examples/music-generation-pipeline-bundle.json)
- [`music-bundle-to-execution-plan-set.json`](../../../../libs/actuators/orchestrator-actuator/examples/music-bundle-to-execution-plan-set.json)
- [`music-bundle-to-run-execution-plan-set.json`](../../../../libs/actuators/orchestrator-actuator/examples/music-bundle-to-run-execution-plan-set.json)

## 5. Expected Output

- ComfyUI `prompt_id`
- `generation-job` when submitted asynchronously
- generated artifact metadata
- resolved source artifact path under local Comfy output
- optional governed copy at `output.target_path`

## 6. Design Rule

Do not treat Comfy node graphs as the public API.  
Reasoning and orchestration should speak `music-generation-adf`; backend-specific workflow details stay inside the compiler and actuator.

For recurring work, do not overload `generation-job` with cron semantics.  
Use `generation-schedule` to describe the trigger and `generation-job` for each concrete execution.

For a full music-video production flow that reuses the generated music artifact, see:

- [`produce-music-video.md`](produce-music-video.md)
