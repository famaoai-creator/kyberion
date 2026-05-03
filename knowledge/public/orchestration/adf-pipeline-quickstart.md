---
title: ADF Pipeline Quickstart
kind: playbook
tags: [orchestration, adf, pipeline, quickstart]
---

# ADF Pipeline Quickstart

Use this page when you need to build, validate, or revise an ADF pipeline without drifting into ad hoc logic.

For the full learning model, see:

- [ADF Pipeline Learning Playbook](./adf-pipeline-learning-playbook.md)
- [ADF Pipeline Template](./adf-pipeline-template.md)

## 1. Freeze the target

Before writing ADF, lock these four things:

- What artifact must exist at the end
- Which tier it belongs to
- Which actuator(s) must run
- How success will be judged

If the artifact is confidential, also lock:

- the required `mission_tier`
- the minimum persona or role that is allowed to write it

If you cannot name the final artifact, do not start.

## 2. Start with the smallest runnable shape

Prefer the smallest shape that proves the outcome:

- `capture -> reasoning -> write -> validate`
- `browser capture -> reasoning -> write`
- `input -> transform -> write`

Do not add orchestration, fan-out, or recovery until the minimal shape works.

## 3. Make runtime context explicit

Bind these values explicitly when the pipeline depends on runtime state:

- `mission_id`
- `session_id`
- `browser_session_id`
- `source_url`
- `target_artifact`

Avoid hidden cwd, implicit browser state, and unresolved placeholders.

## 4. Use canonical ops only

Prefer governed operators that already exist in the repository.

- Use the right operator domain for the job
- Use the right write primitive for the target artifact type
- Avoid unsupported `apply` / `control` / `write` combinations

If the operator name has not been validated against the actuator, treat it as unsafe.

For reasoning steps, prefer the lightest path that still matches the task:

- use plain `reasoning` prompt mode for short synthesis and straightforward analysis
- use `use_subagent: true` only for deeper exploration, comparison, multi-file synthesis, or review work that benefits from autonomous decomposition
- keep structured JSON-producing steps on prompt mode unless you truly need subagent autonomy

## 5. Preflight before execution

Before running real data:

- Validate the ADF shape
- Check that all placeholders resolve
- Confirm that every referenced path exists
- Confirm tier-safe write targets
- Confirm the run has the right persona or role for confidential outputs
- Confirm the chosen actuator supports the step types

If any of these fail, repair the pipeline first.

When a failure occurs, classify it before retrying:

- actuator load failure
- actuator runtime failure
- unsupported operator
- environment / network failure

## 6. Smoke test with real input

Run the pipeline at least once against real data.

For browser pipelines:

- Reuse the same browser session across capture and reasoning
- Confirm the capture is not `about:blank`
- Confirm the saved output contains real extracted structure, not fallback text

For concept-to-prototype pipelines:

- Check that the output is usable, not just syntactically valid
- Confirm the theme survives repeated runs

## 7. Repeat and compare

Run the same input more than once when stability matters.

Look for:

- structure drift
- output path drift
- placeholder leakage
- unsupported-op fallback
- tier-crossing writes

If the run is not stable, the pipeline is not ready for standardization.

## 8. Promote lessons back into knowledge

After a successful or failed run, capture what changed:

- what input was used
- what broke
- what the actuator actually supported
- what should become a template or rule

Store the learning in `knowledge/public/orchestration/` so the next pipeline starts from a better baseline.

## 9. Fast decision rule

Use this rule of thumb:

- **0-4 points**: prototype only
- **5-7 points**: usable with guardrails
- **8-10 points**: candidate for template / standard pipeline

Score yourself on:

- outcome clarity
- context explicitness
- operator correctness
- validation quality
- repeatability

## 10. Default starter

If you are unsure where to begin, copy the standard shape from:

- [ADF Pipeline Template](./adf-pipeline-template.md)

Then trim it down until only the minimum verified steps remain.

## 11. One-line operating rule

If you need the shortest possible rule:

**Outcome first, smallest shape second, explicit context third, real-input smoke test before standardization.**
