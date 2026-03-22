# Procedure: Generate Image From ADF

## 1. Goal
Generate a governed image artifact from an `image-generation-adf` contract instead of hand-authoring a raw ComfyUI workflow.

## 2. Dependencies
- **Actuator**: `media-generation-actuator`
- **Runtime**: local ComfyUI with an SDXL-compatible checkpoint available
- **Schema**: [`image-generation-adf.schema.json`](/Users/famaoai/k/a/kyberion/knowledge/public/schemas/image-generation-adf.schema.json)

## 3. Contract Shape
`image-generation-adf` is the stable public interface.

- `prompt` / `negative_prompt`: subject and exclusions
- `canvas`: width and height
- `style`: mood, camera, render hints
- `engine`: checkpoint, sampler, scheduler, steps, seed
- `output`: format, governed target path, and optional polling behavior

The actuator compiles this contract into a local SDXL-oriented ComfyUI workflow internally.

## 4. Execution
Example inputs:

- [`image-adf-country-cover.json`](/Users/famaoai/k/a/kyberion/libs/actuators/media-generation-actuator/examples/image-adf-country-cover.json)
- [`submit-image-generation-job.json`](/Users/famaoai/k/a/kyberion/libs/actuators/media-generation-actuator/examples/submit-image-generation-job.json)

Run the synchronous example:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/image-adf-country-cover.json
```

Submit as a first-class `generation-job`:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/submit-image-generation-job.json
```

Follow-up job actions:

- `get_generation_job`
- `wait_generation_job`
- `collect_generation_artifact`

Orchestrator-ready bundle:

- [`image-generation-pipeline-bundle.json`](/Users/famaoai/k/a/kyberion/libs/actuators/orchestrator-actuator/examples/image-generation-pipeline-bundle.json)
- [`image-bundle-to-execution-plan-set.json`](/Users/famaoai/k/a/kyberion/libs/actuators/orchestrator-actuator/examples/image-bundle-to-execution-plan-set.json)
- [`image-bundle-to-run-execution-plan-set.json`](/Users/famaoai/k/a/kyberion/libs/actuators/orchestrator-actuator/examples/image-bundle-to-run-execution-plan-set.json)

## 5. Expected Output
- ComfyUI `prompt_id`
- `generation-job` when submitted asynchronously
- generated image artifact metadata
- resolved source artifact path under local Comfy output
- optional governed copy at `output.target_path`

## 6. Design Rule
Do not expose SDXL node wiring as the public API.  
Reasoning and orchestration should produce `image-generation-adf`; backend graph details stay inside the compiler and actuator.
