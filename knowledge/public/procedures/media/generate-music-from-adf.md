# Procedure: Generate Music From ADF

## 1. Goal
Generate a governed music artifact from a human-readable `music-generation-adf` contract instead of submitting a raw ComfyUI workflow.

## 2. Dependencies
- **Actuator**: `media-generation-actuator`
- **Runtime**: local ComfyUI with ACE-Step models available
- **Schema**: [`music-generation-adf.schema.json`](../../schemas/music-generation-adf.schema.json)

## 3. Contract Shape
`music-generation-adf` is the stable public interface.

- `style`: genre, mood, vocal traits
- `composition`: duration, BPM, key, structure
- `lyrics`: provided or instrumental mode
- `arrangement`: instrument and mix hints
- `engine`: backend profile and model overrides
- `output`: filename prefix, governed target path, polling behavior

The actuator compiles this contract into an ACE-Step ComfyUI workflow internally.

## 4. Execution
Example input:

- [`music-adf-anniversary-country-ja.json`](../../../../libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json)
- [`submit-music-generation-job.json`](../../../../libs/actuators/media-generation-actuator/examples/submit-music-generation-job.json)
- [`music-generation-schedule-anniversary.json`](../../../../libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json)

Run:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json
```

Long-running job submission:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js \
  --input libs/actuators/media-generation-actuator/examples/submit-music-generation-job.json
```

Follow-up job actions:

- `get_generation_job`
- `wait_generation_job`
- `collect_generation_artifact`

Recurring schedule contract:

- `generation-schedule` expresses when a job template should be submitted
- `generation-job` expresses one concrete run of that template
- scheduler runtime is intentionally separate from the media actuator

Scheduler runtime:

```bash
pnpm generation:schedule --action register --input libs/actuators/media-generation-actuator/examples/music-generation-schedule-anniversary.json
pnpm generation:schedule --action tick
```

If the latest job has completed successfully and `delivery_policy.latest_alias_path` is set, the scheduler updates that alias copy during `tick`.

Orchestrator-ready bundle:

- [`music-generation-pipeline-bundle.json`](../../../../libs/actuators/orchestrator-actuator/examples/music-generation-pipeline-bundle.json)
- [`music-bundle-to-execution-plan-set.json`](../../../../libs/actuators/orchestrator-actuator/examples/music-bundle-to-execution-plan-set.json)
- [`music-bundle-to-run-execution-plan-set.json`](../../../../libs/actuators/orchestrator-actuator/examples/music-bundle-to-run-execution-plan-set.json)

## 5. Expected Output
- ComfyUI `prompt_id`
- `generation-job` when submitted asynchronously
- generated artifact metadata
- resolved source artifact path under local Comfy output
- optional governed copy at `output.target_path`

## 6. Design Rule
Do not treat Comfy node graphs as the public API.  
Reasoning and orchestration should speak `music-generation-adf`; backend-specific workflow details stay inside the compiler and actuator.

For recurring work, do not overload `generation-job` with cron semantics.  
Use `generation-schedule` to describe the trigger and `generation-job` for each concrete execution.
