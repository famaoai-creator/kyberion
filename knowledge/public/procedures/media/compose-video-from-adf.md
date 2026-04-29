# Procedure: Compose Video From ADF

## 1. Goal

Prepare a governed composed-video bundle from a `video-composition-adf` contract.

This path is for deterministic scene composition, not prompt-led model generation.

For single-action scenario execution (`brief -> compile -> prepare`), use:

- [`create-narrated-intro-movie.md`](./create-narrated-intro-movie.md)

## 2. Dependencies

- **Actuator**: `video-composition-actuator`
- **Schema**: [`video-composition-adf.schema.json`](../../schemas/video-composition-adf.schema.json)
- **Brief Schema**: [`narrated-video-brief.schema.json`](../../schemas/narrated-video-brief.schema.json)
- **Governance**:
  - [`video-composition-template-registry.json`](../../governance/video-composition-template-registry.json)
  - [`video-render-runtime-policy.json`](../../governance/video-render-runtime-policy.json)

## 3. Contract Shape

`video-composition-adf` is the stable public interface.

- `composition`: duration, fps, width, height, background
- `scenes`: explicit scene timing plus template references
- `audio`: narration/music/captions references
- `output`: target format plus bundle location

The current implementation prepares deterministic source artifacts:

- `index.html`
- `render-plan.json`
- per-scene `compositions/*.html`

When backend rendering is enabled and a narration reference is present, the renderer should mux the audio track into the final output artifact instead of stopping at a silent bundle.

## 4. Execution

Example input:

- [`prepare-product-explainer.json`](../../../../libs/actuators/video-composition-actuator/examples/prepare-product-explainer.json)
- [`compile-kyberion-intro-brief.json`](../../../../libs/actuators/video-composition-actuator/examples/compile-kyberion-intro-brief.json)

Run the actuator directly:

```bash
pnpm build
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/prepare-product-explainer.json
```

Compile a narrated brief first:

```bash
pnpm build
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/compile-kyberion-intro-brief.json
```

Use the built JS entrypoint in shell-driven scenarios. Avoid `ts-node` unless you are intentionally debugging the source tree.

Job control actions (for long-running mode in the same actuator process):

- `get_video_composition_job_status` (`params.job_id` required)
- `await_video_composition_job` (`params.job_id` required, `params.timeout_ms` optional)
- `cancel_video_composition_job` (`params.job_id` required, `params.reason` optional)
- `get_video_composition_queue`

Set `video_composition_adf.output.await_completion = false` to enqueue and return immediately.
When backend rendering is enabled and `await_completion` is omitted, the actuator defaults to asynchronous queue mode.
`get_video_composition_job_status` includes `diagnostics` (e.g., cancellation reason, backend exit signal/code).
`diagnostics` also includes lifecycle fields: `created_at`, `started_at`, `finished_at`, `duration_ms`, `terminal_status`.

## 5. Expected Output

- bundle artifact refs
- progress packets for validation/template resolution/bundle assembly
- queued packets include `queue` metadata (position, queued count, running count, concurrency)
- governed source bundle under `active/shared/tmp/video-composition/`
- final rendered artifact with narration muxed when `audio.narration_ref` is supplied and backend rendering is enabled

## 6. Design Rule

Treat `video-composition-adf` as the public contract for deterministic composed video.
Do not overload `video-generation-adf` with scene-template semantics that belong to composed-video rendering.
