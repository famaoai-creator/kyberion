# Procedure: Produce Music Video

## 1. Goal

Produce a music video from governed contracts, keep the audio and video responsibilities separate, and allow the render to survive long-running execution by using background job collection when needed.

This procedure covers the full production flow for MV work in Kyberion:

- music intent capture
- music generation
- visual composition
- render submission
- deferred collection for long jobs
- artifact validation
- service preflight for local media services

It is the operational flow for music videos, not a prompt-only generation path.

## 2. When To Use

Use this procedure when the task is:

- a music video
- a song-driven promo clip
- a music-backed launch asset
- a long render that may outlive the current agent session

If you only need the music artifact itself, use:

- [`generate-music-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/generate-music-from-adf.md)

If you only need the final visual render contract, use:

- [`create-music-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/create-music-video-from-adf.md)
- [`compose-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/compose-video-from-adf.md)

## 3. Inputs

Minimum inputs:

- `music-generation-adf`
- `video-composition-adf`
- a clear `audio.music_ref`
- output path
- bundle directory

Recommended additional inputs:

- `presentation_mode`
- `design_system_ref`
- `duration_sec`
- `profile_id`
- mission evidence directory
- local media runtime availability

## 4. Recommended Workflow

### 4.1 Capture The Music Intent

Start from the musical purpose:

- genre
- mood
- length
- vocal requirements
- whether the song is instrumental or lyric-driven

Keep the music brief separate from the visual brief.

### 4.2 Preflight The Media Runtime

Before you submit a music-video render that depends on local media generation, verify the local runtime:

```bash
pnpm service:preflight -- --service media-generation
```

If this fails, treat it as an infrastructure issue, not a video-contract issue. Resolve the media runtime first, then continue with the music and video contracts.

### 4.3 Generate The Music

Compile the music intent into a `music-generation-adf` and submit it through the media-generation actuator.

For long-running jobs:

1. submit as a `generation-job`
2. persist the returned `job_id`
3. wait or collect later with `wait_generation_job`
4. call `collect_generation_artifact` when the job is succeeded

The music job runtime is already designed around durable `generation-job` records.

### 4.4 Build The Video Contract

Once the music artifact path is known, reference it explicitly from `video-composition-adf.audio.music_ref`.

Keep the visual story deterministic:

- decide the scene order
- assign one job per beat
- keep the audio reference external to the scene logic

### 4.5 Render

Choose one of two render modes:

#### Short render

Use the single-action path when the video render is expected to finish quickly:

- compile the video contract
- render synchronously
- validate the final artifact

#### Long render

Use the background path when the render may outlive the current session:

1. submit with `await_completion = false`
2. set `detached_background = true` when you want a durable ticket for later collection
3. persist the returned `job_id`
4. persist the returned `job_ticket_path`
5. continue other work or stop the session
6. collect later with `await_video_composition_job`

The bundle directory contains the durable ticket file:

- `job-state.json`

### 4.6 Validate

After collection, verify the output artifact:

- file exists
- audio stream exists
- video stream exists
- the music is actually muxed into the final artifact
- the duration matches the expected runtime

## 5. Concrete Command Flow

### 5.1 Build

Build the repo before long-running or detached flows:

```bash
pnpm build
```

### 5.2 Generate Music

Use the music generation procedure or submit a music generation job:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/submit-music-generation-job.json
```

This step requires an active media-generation service endpoint. If the endpoint is unavailable, provision the service first or swap in a pre-generated music artifact before attempting the video render.

For a service-free smoke test of the background render path, use:

- [`music-video-from-brief-smoke.json`](/Users/famao/kyberion/knowledge/product/pipeline-templates/music-video-from-brief-smoke.json)

### 5.3 Render The Music Video

Use the governed composition path once the audio reference is available:

```bash
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/prepare-product-explainer.json
```

For a music-video scenario, the composition contract should set `audio.music_ref` to the generated music artifact path.

### 5.4 Background Submit And Collect

For longer music-video renders, use the same submit/collect pattern as narrated video work.

The current reusable reference lives here:

- [`music-video-from-brief-submit.json`](/Users/famao/kyberion/knowledge/product/pipeline-templates/music-video-from-brief-submit.json)
- [`music-video-from-brief-collect.json`](/Users/famao/kyberion/knowledge/product/pipeline-templates/music-video-from-brief-collect.json)

These templates can be copied into a tenant-specific runnable pipeline or executed directly in dev/testing with `pnpm pipeline --input ...`. They keep the music job and the video render separate, then collect through the saved `job-state.json`.

## 6. Operational Rules

- Keep music generation and video rendering on separate contracts.
- Do not hide the music reference inside the visual scene description.
- Use the job ticket path for long render recovery.
- Treat publish as a separate boundary from render completion.
- Prefer deterministic scene planning over ad hoc visual scripting.

## 7. Expected Outputs

The completed flow should leave:

- a music artifact
- a video composition contract
- a rendered bundle
- a final video artifact with music muxed when backend rendering is enabled
- `job-state.json` for long renders
- validation output
