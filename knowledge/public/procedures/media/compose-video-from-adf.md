# Procedure: Compose Video From ADF

## 1. Goal

Prepare a governed composed-video bundle from a `video-composition-adf` contract.

This path is for deterministic scene composition, not prompt-led model generation.

For single-action scenario execution (`brief -> compile -> prepare`), use:

- [`create-narrated-intro-movie.md`](/Users/famaoai/k/d/kyberion/knowledge/public/procedures/media/create-narrated-intro-movie.md)

## 2. Dependencies

- **Actuator**: `video-composition-actuator`
- **Schema**: [`video-composition-adf.schema.json`](/Users/famaoai/k/d/kyberion/knowledge/public/schemas/video-composition-adf.schema.json)
- **Brief Schema**: [`narrated-video-brief.schema.json`](/Users/famaoai/k/d/kyberion/knowledge/public/schemas/narrated-video-brief.schema.json)
- **Governance**:
  - [`video-composition-template-registry.json`](/Users/famaoai/k/d/kyberion/knowledge/public/governance/video-composition-template-registry.json)
  - [`video-render-runtime-policy.json`](/Users/famaoai/k/d/kyberion/knowledge/public/governance/video-render-runtime-policy.json)

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

## 4. Execution

Example input:

- [`prepare-product-explainer.json`](/Users/famaoai/k/d/kyberion/libs/actuators/video-composition-actuator/examples/prepare-product-explainer.json)
- [`compile-kyberion-intro-brief.json`](/Users/famaoai/k/d/kyberion/libs/actuators/video-composition-actuator/examples/compile-kyberion-intro-brief.json)

Run the actuator directly:

```bash
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/prepare-product-explainer.json
```

Compile a narrated brief first:

```bash
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/compile-kyberion-intro-brief.json
```

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

## 6. Design Rule

Treat `video-composition-adf` as the public contract for deterministic composed video.
Do not overload `video-generation-adf` with scene-template semantics that belong to composed-video rendering.
