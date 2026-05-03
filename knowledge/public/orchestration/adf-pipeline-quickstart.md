---
title: ADF Pipeline Quickstart
kind: playbook
tags: [orchestration, adf, pipeline, quickstart]
---

# ADF Pipeline Quickstart

Use this quickstart when you want to build, validate, or revise an ADF pipeline with minimal drift.

This page is intentionally short. For the full learning model, see:

- [ADF Pipeline Learning Playbook](./adf-pipeline-learning-playbook.md)
- [ADF Pipeline Template](./adf-pipeline-template.md)

## 1. Start from the outcome

Before writing ADF, freeze these four things:

- What artifact must exist at the end
- Which tier it belongs to
- Which actuator(s) must run
- How success will be judged

If you cannot name the final artifact, do not start with a full pipeline.

## 2. Pick the smallest runnable shape

Prefer the smallest shape that can prove the outcome:

- `capture -> reasoning -> write -> validate`
- `browser capture -> reasoning -> write`
- `input -> transform -> write`

Do not add orchestration, fan-out, or recovery until the minimal shape works.

## 3. Make context explicit

Always bind these values explicitly when the pipeline depends on runtime state:

- `mission_id`
- `session_id`
- `browser_session_id`
- `source_url`
- `target_artifact`

Avoid hidden cwd, implicit browser state, or placeholder strings that are never resolved.

## 4. Use canonical ops only

Prefer governed operators that already exist in the repository.

- Use the right operator domain for the job
- Use the right write primitive for the target artifact type
- Avoid unsupported `apply` / `control` / `write` combinations

If the operator name looks plausible but has not been validated against the actuator, treat it as unsafe.

## 5. Preflight before execution

Before running real data:

- Validate the ADF shape
- Check that all placeholders resolve
- Confirm that every referenced path exists
- Confirm tier-safe write targets
- Confirm the chosen actuator supports the step types

If any of these fail, repair the pipeline first.

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
