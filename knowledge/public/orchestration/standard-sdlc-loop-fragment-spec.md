# Standard SDLC Loop Fragment Spec

**Date**: 2026-05-04  
**Purpose**: Define the reusable SDLC skeleton shared by onboarding / design pipelines

## 1. Problem

Multiple pipelines repeat the same execution arc:

- requirements extraction
- design synthesis
- test planning
- task decomposition

This duplication increases maintenance cost and makes the pipeline family drift over time.

## 2. Fragment Name

Proposed conceptual fragment:

- `pipelines/fragments/standard-sdlc-loop.json`

## 3. Fragment Contract

### 3.1 Inputs

The fragment should accept:

- `mission_id`
- `project_name`
- `source_path`
- `source_type`
- `language`
- `customer_name`
- `customer_org`
- `additional_context`
- `validation_profile`

### 3.2 Outputs

The fragment should emit:

- `requirements`
- `design`
- `test_plan`
- `task_plan`
- `summary`

## 4. Canonical Steps

1. `extract_requirements`
2. `synthesize_design`
3. `derive_test_plan`
4. `decompose_tasks`
5. `emit_summary`

## 5. Per-Pipeline Overrides

Each concrete pipeline should only override:

- source document path
- project metadata
- domain-specific additional context
- validation thresholds
- output naming

## 6. Mapping to Existing Pipelines

### 6.1 `platform-onboarding.json`

Use the fragment as the full skeleton.

### 6.2 `faas-add-api.json`

Use the fragment for requirements/design/test/task planning, then append execution-specific steps outside the fragment.

### 6.3 `design-from-requirements.json`

Use the fragment as a reduced form that stops after the design step when only design synthesis is needed.

## 7. Why This Fragment Is Worth It

- the SDLC shape is already stable
- the same pattern appears in more than one pipeline
- the shared skeleton is readable and meaningful
- per-pipeline specialization can stay small

## 8. Guardrail

Do not turn the fragment into a black box.

The fragment must remain inspectable so reviewers can see:

- what source was read
- what design was chosen
- what test plan was generated
- what tasks were decomposed

## 9. Runtime Note

Literal `ref` support is still not confirmed in the evidence we checked.

So this spec should be treated as the design contract for abstraction, not as a claim that the runtime already supports the exact fragment syntax.

## 10. Recommendation

Implement the simplify mission first, then adopt this fragment spec as the next abstraction milestone.

---
*Spec distilled on 2026-05-04*
