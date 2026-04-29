# Procedure: Generate Video From ADF

## 1. Goal
Generate a governed video artifact from a `video-generation-adf` contract while keeping backend workflow details internal to the compiler and actuator.

## 2. Dependencies
- **Actuator**: `media-generation-actuator`
- **Runtime**: local ComfyUI with a compatible video workflow
- **Schema**: [`video-generation-adf.schema.json`](../../schemas/video-generation-adf.schema.json)

## 3. Contract Shape
`video-generation-adf` is the stable public interface.

- `prompt` / `negative_prompt`: shot intent and exclusions
- `composition`: duration, fps, aspect ratio
- `engine`: use a named `workflow_template` when possible; `embedded` remains as an escape hatch
- `output`: format, governed target path, and optional polling behavior

Current implementation hydrates typed placeholders into a named or embedded workflow template, then submits the resolved workflow to ComfyUI.

## 4. Execution
Example inputs:

- [`video-adf-drive-clip.json`](../../../../libs/actuators/media-generation-actuator/examples/video-adf-drive-clip.json)
- [`submit-video-generation-job.json`](../../../../libs/actuators/media-generation-actuator/examples/submit-video-generation-job.json)

Run the direct example:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/video-adf-drive-clip.json
```

Submit as a first-class `generation-job`:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/submit-video-generation-job.json
```

Follow-up job actions:

- `get_generation_job`
- `wait_generation_job`
- `collect_generation_artifact`

Orchestrator-ready bundle:

- [`video-generation-pipeline-bundle.json`](../../../../libs/actuators/orchestrator-actuator/examples/video-generation-pipeline-bundle.json)
- [`video-bundle-to-execution-plan-set.json`](../../../../libs/actuators/orchestrator-actuator/examples/video-bundle-to-execution-plan-set.json)
- [`video-bundle-to-run-execution-plan-set.json`](../../../../libs/actuators/orchestrator-actuator/examples/video-bundle-to-run-execution-plan-set.json)

## 5. Expected Output
- ComfyUI `prompt_id`
- `generation-job` when submitted asynchronously
- generated video artifact metadata
- resolved source artifact path under local Comfy output
- optional governed copy at `output.target_path`

## 6. Design Rule
Treat the `video-generation-adf` as the public contract and the embedded workflow only as a current backend strategy.  
Do not let orchestration couple itself directly to Comfy node graphs.
