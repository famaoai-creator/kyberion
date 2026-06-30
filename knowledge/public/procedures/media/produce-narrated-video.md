# Procedure: Produce Narrated Video

## 1. Goal

Produce a narrated video from an approved brief, render it deterministically, and keep the job recoverable when the render takes longer than the current agent session.

This procedure describes the actual production flow used in Kyberion:

- brief capture
- storyboard and narration preparation
- render submission
- deferred collection for long jobs
- artifact validation
- publish handoff

It is the operational path for narrated videos, not a prompt-based video generator.

## 2. When To Use

Use this procedure when the task is:

- a narrated product video
- a how-to clip
- a VTuber-style demo
- a long render that should survive agent interruption
- a repeatable mission that needs traceable evidence

If the task is just a single short render and you do not need deferred collection, use:

- [`create-narrated-intro-movie.md`](/Users/famao/kyberion/knowledge/public/procedures/media/create-narrated-intro-movie.md)

If you already have a final `video-composition-adf`, use:

- [`compose-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/compose-video-from-adf.md)

## 3. Inputs

Minimum inputs:

- `video-content-brief` or `narrated-video-brief`
- narration asset reference
- output path
- bundle directory

Recommended additional inputs:

- `presentation_mode`
- `design_system_ref`
- `duration_sec`
- `profile_id`
- mission evidence directory

## 4. Recommended Workflow

### 4.1 Capture The Brief

Start from the intended outcome, audience, and runtime.

Keep these distinct:

- what the video is for
- how it should feel
- what should be proven on screen

When the request is still fuzzy, normalize it into a `video-content-brief` first.
When the structure is already known, compile directly into a `narrated-video-brief`.

### 4.2 Prepare Narration

Generate narration before render work.

For narrated video production:

- keep the narration asset explicit
- store it in the mission evidence directory
- avoid embedding the narration logic inside the render step

### 4.3 Render

Choose one of two render modes:

#### Short render

Use the single-action path when the render is expected to finish quickly:

- compile the brief
- render synchronously
- validate the final artifact

#### Long render

Use the background path when the render may outlive the current session:

1. submit with `await_completion = false`
2. set `detached_background = true`
3. persist the returned `job_id`
4. persist the returned `job_ticket_path`
5. continue other work or stop the session
6. collect later with `await_video_composition_job`

The bundle directory contains the durable ticket file:

- `job-state.json`

That ticket is the source of truth for later recovery and collection.

### 4.4 Validate

After collection, verify the output artifact:

- file exists
- audio stream exists when narration is expected
- video stream exists
- duration alignment is acceptable
- no black-frame output was produced

### 4.5 Publish Handoff

Treat publish as a separate boundary.

Before external release, record:

- final artifact path
- bundle directory
- validation result
- publish plan or approval status

## 5. Concrete Command Flow

### 5.1 Build

Build the repo before running the detached worker path:

```bash
pnpm build
```

### 5.2 Submit A Long Render

Use the submit pipeline when you want to start a render and continue later:

```bash
pnpm pipeline --input pipelines/kyberion-vtuber-narrated-demo-submit.json
```

The submit step returns a job ticket path in the bundle directory.

### 5.3 Collect The Result

Later, collect the result from the saved ticket:

```bash
pnpm pipeline --input pipelines/kyberion-vtuber-narrated-demo-collect.json
```

### 5.4 Validate A Completed Artifact

Run the narrated-video validation fragment or the actuator verification path after collection.

## 6. Operational Rules

- Prefer `video-content-brief` first when the brief is still being shaped.
- Keep `brief`, `storyboard`, `narration`, and `render` as separate responsibilities.
- Do not assume the agent session will survive a long render.
- Do not lose the job ticket path once the render is submitted.
- Use the built JS entrypoint when the pipeline shells out to the actuator.
- Use the mission evidence directory for all artifacts that must be recovered later.

## 7. Expected Outputs

The completed flow should leave:

- a content brief or narrated brief
- narration audio
- a render bundle
- a final video artifact
- `job-state.json` for long renders
- validation output
- a summary note or publish handoff

