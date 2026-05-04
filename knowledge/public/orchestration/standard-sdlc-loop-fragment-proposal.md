# Standard SDLC Loop Fragment Proposal

**Date**: 2026-05-04  
**Purpose**: Extract the repeated SDLC skeleton used by onboarding / design pipelines into a shared conceptual fragment

## 1. Target Pattern

The following pipeline family repeats the same core shape:

- requirements extraction
- design synthesis
- test planning
- task decomposition

Observed pipelines:

- `platform-onboarding.json`
- `faas-add-api.json`
- `design-from-requirements.json`

## 2. Shared Skeleton

Proposed fragment name:

- `pipelines/fragments/standard-sdlc-loop.json`

Proposed conceptual steps:

1. capture source brief
2. extract requirements
3. synthesize design
4. derive test plan
5. decompose tasks
6. emit summary

## 3. What Should Stay Per-Pipeline

The fragment should not erase pipeline identity. Per-pipeline differences should remain in:

- project metadata
- source document path
- additional context
- validation thresholds
- domain-specific constraints

## 4. Benefits

- fewer repeated step definitions
- easier policy updates
- easier review of the common SDLC shape
- less drift between similar pipelines

## 5. Caution

Do not abstract away the output contract so far that the specific pipeline purpose becomes unclear.

The fragment should reduce duplication, not create a new layer of indirection that hides the actual work.

## 6. Dependency Note

The runtime support for a literal `ref` step is not yet confirmed in the current evidence set.  
If `ref` is not supported, the next best step is to model the shared skeleton as a maintained design convention before changing runtime semantics.

## 7. Recommendation

Use this fragment proposal as the design basis for the abstraction mission after the simplify mission is stabilized.

---
*Proposal distilled on 2026-05-04*
