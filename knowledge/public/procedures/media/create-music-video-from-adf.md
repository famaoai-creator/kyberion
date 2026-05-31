# Procedure: Create Music Video From ADF

## 1. Goal

Execute a governed music-video flow that:

- captures a music-video intent as a brief
- generates the music track from `music-generation-adf`
- compiles the video side into `video-composition-adf`
- muxes the generated music into the final rendered output when backend rendering is enabled

This procedure is for the common music-video case where the visual story is driven by the song rather than by narration.

## 2. Dependencies

- **Actuator**: `media-generation-actuator`
- **Actuator**: `video-composition-actuator`
- **Schemas**:
  - [`music-generation-adf.schema.json`](/Users/famao/kyberion/knowledge/public/schemas/music-generation-adf.schema.json)
  - [`video-composition-adf.schema.json`](/Users/famao/kyberion/knowledge/public/schemas/video-composition-adf.schema.json)
- **Procedure**:
  - [`compose-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/compose-video-from-adf.md)

## 3. Contract Shape

Use two governed contracts:

1. `music-generation-adf` for the audio track
2. `video-composition-adf` for the visuals and final muxing

The video composition should reference the generated music with:

- `audio.music_ref`

If both `audio.narration_ref` and `audio.music_ref` are present, narration is muxed first. For a true music-video path, leave narration empty.

## 4. Execution

Suggested flow:

1. Define the music intent and generate the music artifact.
2. Define the video brief and compile the scene plan.
3. Copy the music artifact path into `video-composition-adf.audio.music_ref`.
4. Render the composed video bundle.

For pipeline-first runs, the simplest execution path is to call `video-composition:prepare_video_composition` with a fully formed `video-composition-adf` that already references `audio.music_ref`. That keeps audio generation and video rendering on separate contracts while avoiding shell-side mux branching.

Example music generation:

```bash
pnpm build
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json
```

Example composition render:

```bash
pnpm build
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/prepare-product-explainer.json
```

For a music-video scenario, replace the example composition with an ADF that sets `audio.music_ref` to the generated music artifact.

Pipeline example:

```bash
pnpm pipeline --input pipelines/music-video-from-brief.json
```

The demo pipeline uses a governed video composition ADF, then verifies that the final artifact contains both audio and video streams.

## 5. Expected Output

- generated music artifact metadata
- compiled `video-composition-adf`
- deterministic composed-video bundle
- final rendered artifact with music muxed when backend rendering is enabled

## 6. Design Rule

Treat `music-generation-adf` and `video-composition-adf` as separate governed interfaces.
Do not push music-specific composition semantics into the generic video generation path.
