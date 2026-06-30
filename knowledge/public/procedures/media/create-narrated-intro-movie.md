# Procedure: Create Narrated Intro Movie

## 1. Goal

Execute a single top-level scenario that:

- compiles a `narrated-video-brief` into `video-composition-adf`
- renders a composed video bundle and, when narration is present, muxes the audio track into the final output
- when a `video-content-brief` is available, prefer compiling it into a storyboard and then rendering through `create_narrated_video_from_content_brief`
- include `presentation_mode` (`howto`, `promo`, or `vtuber`) so the storyboard can choose the correct layout family

## 2. Dependencies

- **Actuator**: `video-composition-actuator`
- **Schemas**:
  - [`narrated-video-brief.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/narrated-video-brief.schema.json)
  - [`video-content-brief.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/video-content-brief.schema.json)
  - [`video-composition-action.schema.json`](/Users/famao/kyberion/schemas/video-composition-action.schema.json)
- **Procedure**:
  - [`compose-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/compose-video-from-adf.md)

## 3. Contract Shape

Action:

- `create_narrated_intro_movie`

Required:

- `params.narrated_video_brief`
- or `params.video_content_brief` and `params.narration_artifact_ref` when using `create_narrated_video_from_content_brief`

Optional:

- `params.job_id`
- `params.bundle_dir`

## 4. Execution

Example input:

- [`create-kyberion-intro-movie.json`](/Users/famao/kyberion/libs/actuators/video-composition-actuator/examples/create-kyberion-intro-movie.json)

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

## 6. Story and narration discipline

This procedure should not be used as a shortcut to "write HTML and render it."
Follow the same structure HyperFrames uses for production videos:

- write the narration or voiceover copy first
- split it into beats and scene responsibilities
- keep storyboard and narration separate from render code
- choose the renderer after the narrative structure is stable
- validate that the visuals appear slightly before the narration reaches the
  same idea
- for Japanese promo narration on macOS, prefer the native `say` path with a clearly intelligible voice such as `Kyoko`; treat `espeak-ng` as fallback only

That means the usual Kyberion flow should be:

1. build or choose a `video-content-brief`
2. compile it to a storyboard
3. synthesize narration
4. compile `narrated-video-brief`
5. render `video-composition-adf`
6. mux and verify the final artifact

This is the composed-video equivalent of HyperFrames' `writer`,
`storyboarder`, `voice-talent`, `renderer`, and `editor` roles.

When backend rendering is enabled and `await_completion` is omitted, `execution.status` will default to `queued`.
When you want a longer render to survive operator attention shifts, use the background pattern from
[`compose-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/compose-video-from-adf.md):

- submit with `await_completion: false`
- persist the returned `job_id` and `job_ticket_path`
- collect later with `await_video_composition_job`

For the end-to-end operator workflow, including brief capture, narration, submit, collect, and validation, use:

- [`produce-narrated-video.md`](/Users/famao/kyberion/knowledge/public/procedures/media/produce-narrated-video.md)
