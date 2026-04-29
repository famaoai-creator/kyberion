# Execution Improvement Report

## Summary

Kyberion's main constraint is no longer uncontrolled execution. The constraint is strict contract handling that still exposes too much actuator-specific friction to operators and upstream intent resolution.

This report tracks the hardening work needed to improve execution smoothness without weakening governance.

## Addressed In This Iteration

### Multilingual Archetype Detection

- Japanese request patterns now feed archetype detection through a bridge layer in [orchestrator-actuator](../../../libs/actuators/orchestrator-actuator/src/index.ts).
- The current approach adds English detection hints instead of translating the entire request, which reduces semantic drift.

### Intelligent Input Binding

- `request_to_execution_brief` now binds more required inputs from `context` and alias keys.
- Execution briefs now expose:
  - `provided_inputs`
  - `inferred_inputs`
  - `input_bindings`
- `resolution_plan_to_pipeline_bundle` now falls back to `execution_brief` and `brief` to reduce brittle context-key mismatches.

### Cross-Project Analysis Process Design

- Analysis-heavy intents such as `cross-project-remediation` and `incident-informed-review` now map to explicit `process_design` entries.
- The runtime now adds:
  - suggested references
  - governed analysis briefs
  - impact bands
  - bounded follow-up mission seeds

### Deep Object Reference Stability

- Core logic utilities now support indexed and deep path access with `getPathValue()`.
- `resolveVars()` and `evaluateCondition()` now use the same deep-path logic, including `env.*` lookups.
- Major actuators now use the shared deep-path behavior for:
  - conditional control flow
  - `json_query`
  - write-from-context resolution

### Unified Write Artifact Contract

- Core now exposes `resolveWriteArtifactSpec()`.
- Major actuators accept:
  - `path`
  - `output_path`
  - `content`
  - `data`
  - `from`
- `write_artifact` is now accepted alongside existing `write_file` or domain-native write operators where applicable.

## Remaining Gaps

### Retrieval Quality

- `suggested_refs` and snippet extraction are now governed, but retrieval is still shallow.
- Next step:
  - rank refs by target fit
  - prefer track/project-local evidence over broad knowledge hits

### Repo-Bound Review Execution

- Review targets can now be inferred as `pull_request:*`, `file:*`, `artifact:*`, `repository:*`, `track:*`, or `project:*`.
- These targets are not yet fully bound to actual repo execution flows.

### Narrative Expansion

- Media rendering has improved, but storyline generation still under-expands many briefs.
- Next step:
  - add presentation pattern presets
  - expand multi-slide storyline generation from intent and audience context

### Explicit LLM / Compiler / Renderer Boundary

- Media generation now needs to remain strict about where intelligence lives.
- Next step:
  - keep `document_profile` and `sections` in knowledge
  - keep `brief -> protocol` mapping in the compiler
  - keep binary emission in renderers
  - let the LLM draft content only inside those governed slots

### Actuator I/O Standardization Coverage

- Shared write handling now exists, but not every actuator has been normalized to the same degree.
- Next step:
  - converge remaining write-style operators onto the same contract surface
  - document preferred ADF signatures for artifact emission

## Priority

1. Retrieval and target binding
2. Narrative expansion
3. Remaining actuator contract normalization
4. Operator-facing clarification UX

## Principle

Kyberion should remain strict about governance and explicit contracts. The goal is not to make execution looser. The goal is to make strictness easier to satisfy.
