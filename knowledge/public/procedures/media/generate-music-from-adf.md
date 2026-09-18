# Procedure: Generate Music From ADF

## 1. Goal

Generate a governed music artifact from a human-readable `music-generation-adf` contract instead of submitting a raw ComfyUI workflow.

## 2. Dependencies

- **Actuator**: `media-generation-actuator`
- **Default runtime**: local ComfyUI with ACE-Step models available
- **Lightweight local alternatives** (no ComfyUI):
  - `media-generation.musicgen_mlx` — Apple Silicon MusicGen via `mlx-audiocraft` (`KYBERION_MUSICGEN_*`)
  - `media-generation.stable_audio_3_small_music` — Stable Audio 3 small-music via git/`uv` (`KYBERION_STABLE_AUDIO_*`; gated HF weights need `HF_TOKEN`)
- **Preflight**: `pnpm service:preflight -- --service media-generation` for ComfyUI; local CLI backends use tool-runtime trial/install
- **Schema**: [`music-generation-adf.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/music-generation-adf.schema.json)

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

# Stable Audio 3 small-music (CPU/MPS; accept HF license + set HF_TOKEN)
uv tool install git+https://github.com/Stability-AI/stable-audio-3.git
# or trial: uvx --from git+https://github.com/Stability-AI/stable-audio-3.git \
#   stable-audio --model small-music -p "lo-fi beat" --duration 30 -o /tmp/out.wav
```

Direct actuator examples:

- [`direct-musicgen-mlx.json`](/Users/famao/kyberion/libs/actuators/media-generation-actuator/examples/direct-musicgen-mlx.json)
- [`direct-stable-audio-3-small-music.json`](/Users/famao/kyberion/libs/actuators/media-generation-actuator/examples/direct-stable-audio-3-small-music.json)

## 4. Execution

Example input:

- [`music-adf-anniversary-country-ja.json`](/Users/famao/kyberion/libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json)
- [`submit-music-generation-job.json`](/Users/famao/kyberion/libs/actuators/media-generation-actuator/examples/submit-music-generation-job.json)
- [`music-generation-schedule-anniversary.json`](/Users/famao/kyberion/libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json)

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

- [`music-generation-pipeline-bundle.json`](/Users/famao/kyberion/libs/actuators/orchestrator-actuator/examples/music-generation-pipeline-bundle.json)
- [`music-bundle-to-execution-plan-set.json`](/Users/famao/kyberion/libs/actuators/orchestrator-actuator/examples/music-bundle-to-execution-plan-set.json)
- [`music-bundle-to-run-execution-plan-set.json`](/Users/famao/kyberion/libs/actuators/orchestrator-actuator/examples/music-bundle-to-run-execution-plan-set.json)

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

- [`produce-music-video.md`](/Users/famao/kyberion/knowledge/public/procedures/media/produce-music-video.md)
