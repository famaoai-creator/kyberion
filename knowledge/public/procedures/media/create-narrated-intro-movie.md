# Procedure: Create Narrated Intro Movie

## 1. Goal

Execute a single top-level scenario that:

- compiles a `narrated-video-brief` into `video-composition-adf`
- enqueues or runs composed-video preparation

## 2. Dependencies

- **Actuator**: `video-composition-actuator`
- **Schemas**:
  - [`narrated-video-brief.schema.json`](/Users/famaoai/k/d/kyberion/knowledge/public/schemas/narrated-video-brief.schema.json)
  - [`video-composition-action.schema.json`](/Users/famaoai/k/d/kyberion/schemas/video-composition-action.schema.json)
- **Procedure**:
  - [`compose-video-from-adf.md`](/Users/famaoai/k/d/kyberion/knowledge/public/procedures/media/compose-video-from-adf.md)

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

- [`create-kyberion-intro-movie.json`](/Users/famaoai/k/d/kyberion/libs/actuators/video-composition-actuator/examples/create-kyberion-intro-movie.json)

Run:

```bash
node dist/libs/actuators/video-composition-actuator/src/index.js \
  --input libs/actuators/video-composition-actuator/examples/create-kyberion-intro-movie.json
```

## 5. Expected Output

The response contains:

- `kind: narrated_intro_movie_run`
- `video_composition_adf` (compiled contract)
- `execution` (same shape as `prepare_video_composition` result)

When backend rendering is enabled and `await_completion` is omitted, `execution.status` will default to `queued`.
