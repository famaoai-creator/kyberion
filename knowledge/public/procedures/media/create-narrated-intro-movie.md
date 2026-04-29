# Procedure: Create Narrated Intro Movie

## 1. Goal

Execute a single top-level scenario that:

- compiles a `narrated-video-brief` into `video-composition-adf`
- renders a composed video bundle and, when narration is present, muxes the audio track into the final output

## 2. Dependencies

- **Actuator**: `video-composition-actuator`
- **Schemas**:
  - [`narrated-video-brief.schema.json`](../../schemas/narrated-video-brief.schema.json)
  - [`video-composition-action.schema.json`](schemas/video-composition-action.schema.json)
- **Procedure**:
  - [`compose-video-from-adf.md`](./compose-video-from-adf.md)

## 3. Contract Shape

Action:

- `create_narrated_intro_movie`

Required:

- `params.narrated_video_brief`

Optional:

- `params.job_id`
- `params.bundle_dir`

## 4. Execution

Example input:

- [`create-kyberion-intro-movie.json`](../../../../libs/actuators/video-composition-actuator/examples/create-kyberion-intro-movie.json)

Run:

```bash
pnpm build
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/create-kyberion-intro-movie.json
```

Use the built JS entrypoint in shell-driven runs. Avoid `ts-node` here unless you are explicitly debugging the source tree.

## 5. Expected Output

The response contains:

- `kind: narrated_intro_movie_run`
- `video_composition_adf` (compiled contract)
- `execution` (same shape as `prepare_video_composition` result)
- final rendered video artifact when backend rendering is enabled
- audio-muxed MP4/MOV/WebM when `narration_ref` is present and the renderer can run

When backend rendering is enabled and `await_completion` is omitted, `execution.status` will default to `queued`.
