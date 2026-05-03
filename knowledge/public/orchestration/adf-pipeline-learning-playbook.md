---
title: ADF Pipeline Learning Playbook
category: Orchestration
tags: [adf, pipeline, learning, preflight, stability, governance]
importance: 9
author: Kyberion
last_updated: 2026-05-03
---

# ADF Pipeline Learning Playbook

This playbook explains how to learn, design, and stabilize ADF pipelines so they are reproducible, governed, and easy to improve over time.

For a copy-ready version, see [ADF Pipeline Template](./adf-pipeline-template.md).
For a short operational entry point, see [ADF Pipeline Quickstart](./adf-pipeline-quickstart.md).

The goal is not only to make a pipeline "work once", but to make it:

- deterministic enough to rerun safely
- explicit enough to review quickly
- stable enough to compare across runs
- governed enough to survive refactors

## 1. Core Principles

### 1.1 Start from the outcome

Write the expected output before writing the pipeline.

Ask:

- What artifact should exist at the end?
- What is the acceptance criterion?
- What evidence proves success?
- What is the failure mode we care about most?

If the answer is vague, the pipeline will usually be unstable.

### 1.2 Keep the execution shape explicit

Every pipeline should make these boundaries visible:

- input
- normalization
- capture
- reasoning
- artifact write
- verification

Do not hide major work in implicit defaults or side effects.

### 1.3 Bind the runtime explicitly

Pipelines should not depend on accidental runtime state.

Prefer explicit values for:

- `session_id`
- `browser_session_id`
- `mission_id`
- `brand_name_slug`
- `source_url`
- `concept_brief`
- `design_theme`

This reduces "works on my machine" behavior and keeps reruns comparable.

### 1.4 Use canonical ops only

Use the step types and operators the runtime already understands.

Common examples:

- `control` for session and branching control
- `capture` for snapshot and read operations
- `transform` for reasoning or structured conversion
- `apply` for writes and execution

If an operator is not canonical, it should be treated as a design smell until proven otherwise.

### 1.5 Preserve tier boundaries

Do not mix tiers casually.

- Personal data stays personal
- Confidential data stays confidential
- Public artifacts stay reusable

If a pipeline crosses tiers, the transfer must be governed and explicit.

### 1.6 Make privileged pipelines explicit

Some pipelines are intentionally privileged.

- If the output is confidential, require `mission_tier=confidential` at the first control step.
- If the pipeline reads or writes confidential evidence, document the expected persona or role.
- If a lower-privilege run fails with a permission error, treat that as a valid guard signal unless the pipeline is supposed to support broader access.

This is especially important for audit, governance, and portfolio-style pipelines.

### 1.7 Treat evidence as part of the product

A pipeline is not complete until the outputs are reviewable.

Store:

- the generated artifact
- the input context
- the trace or log summary
- the acceptance result

## 2. Recommended Learning Loop

Use this sequence when creating or improving a pipeline.

### Step 1: Define the artifact contract

Before writing ADF, define:

- output file path
- output format
- minimum content requirements
- what "good" looks like
- what is intentionally out of scope

Example:

- input: real website snapshot
- output: design spec JSON
- acceptance: contains colors, fonts, and aesthetic summary

### Step 2: Choose the smallest workable runtime shape

Select the simplest actuator path that can produce the artifact.

Prefer:

- one browser session
- one reasoning pass
- one artifact write

Only add branches or fan-out when the use case truly needs them.

### Step 3: Write the ADF skeleton first

Start with the minimum steps:

1. acquire or normalize input
2. capture source evidence
3. reason over evidence
4. write the artifact
5. log the result

Do not add optimizations before the basic loop works.

### Step 4: Make context variables explicit

Every placeholder should have a known source.

Checklist:

- Is the variable resolved by the pipeline runner?
- Is it available at the point where it is used?
- Is the type stable?
- Is the fallback safe?

If a step depends on `{{...}}` values, verify the runner resolves them before execution.

### Step 5: Preflight before execution

Run the relevant checks before treating the pipeline as valid.

At minimum:

- schema validation
- catalog integrity
- governance checks
- tier hygiene checks
- intent/domain coverage when relevant
- persona or role authorization when the pipeline targets confidential artifacts

If the pipeline is generated or repaired, re-run preflight after the change.

### Step 6: Smoke test with real data

Test with a real, non-mock input whenever possible.

For browser pipelines:

- use a real site, not only a synthetic URL
- confirm the snapshot is not `about:blank`
- confirm the session is stable across capture steps

For concept-generation pipelines:

- use a concrete brief
- compare outputs across runs
- ensure the structure, not just the title, is stable

### Step 7: Repeat and compare

Run the same pipeline more than once with the same input.

Compare:

- artifact hash
- key fields
- structure
- missing values
- output confidence

If the outputs differ materially, determine whether the variation is:

- acceptable creative variance
- unstable runtime behavior
- a bad abstraction boundary

### Step 8: Promote learnings into documentation

When a failure or useful pattern repeats, capture it in knowledge.

Good learning artifacts are:

- short
- concrete
- tied to an observed failure
- tied to a specific fix

## 3. High-Value Failure Modes to Watch

These are the failure modes that most often reduce ADF quality.

### 3.1 Wrong operator shape

Example symptoms:

- step type is correct but op domain is wrong
- `apply` used where `control` is needed
- unsupported operator names appear in output

### 3.2 Session split across steps

Example symptoms:

- `open_tab` and `snapshot` run in different browser sessions
- captured state falls back to `about:blank`
- the pipeline reuses a fresh browser instead of the opened page

### 3.3 Placeholder leakage

Example symptoms:

- `{{source_url}}` or other placeholders reach the backend unresolved
- reasoning sees template text instead of real values

### 3.4 Wrong artifact writer

Example symptoms:

- pipeline emits an artifact, but the write op is unsupported
- save step writes to the wrong contract shape
- JSONL is treated as JSON or vice versa

### 3.5 Hidden context drift

Example symptoms:

- same input produces structurally different outputs without a clear reason
- session identifiers change unexpectedly
- output depends on cwd instead of root-scoped resolution

### 3.6 Mock-only validation

Example symptoms:

- a pipeline is judged successful only on synthetic input
- real-site snapshots or real artifact writes were never verified
- browser capture works in theory but not in practice

### 3.7 Nested pipeline shell-outs

Example symptoms:

- one pipeline shells out to run another pipeline
- the report is assembled from opaque sub-pipeline stdout
- the composition is hidden from the ADF graph

Why this is bad:

- traceability is worse than direct ADF composition
- failures become harder to localize
- learning signals are split across multiple runtime layers

Prefer direct capture, transform, and write steps when the underlying signal can be collected in the current pipeline.

### 3.8 Misclassified actuator execution failures

Example symptoms:

- the runner reports an unsupported op even though the actuator loaded correctly
- browser navigation or snapshot errors are collapsed into load failures
- the error message does not distinguish load-time failure from runtime failure

Why this is bad:

- debugging points at the wrong layer
- recovery logic may repair the wrong contract
- retry policy becomes noisy and less trustworthy

Prefer error messages that tell you whether the actuator failed to load, failed to dispatch, or failed while executing a supported step.

### 3.9 Prefer direct reads over shell scraping

If the signal already exists as a known file path, prefer a read op over a shell scrape.

- Use `read_file` for plain-text logs and notes
- Use `read_json` for structured runtime state
- Use shell only when the data source is genuinely dynamic or cannot be addressed directly

Why this is better:

- less hidden formatting drift
- better tier-aware path handling
- clearer failure classification
- easier preflight and replay

## 4. Review Checklist for New Pipelines

Before you call a pipeline stable, check:

- [ ] The output artifact path is explicit
- [ ] The input variables are all resolved
- [ ] The step types match the actuator contract
- [ ] The runtime session is stable across dependent steps
- [ ] The pipeline passes preflight
- [ ] The pipeline works on a real input
- [ ] The output is comparable across at least two runs
- [ ] The artifact can be reviewed without reading source code
- [ ] Any tier crossing is explicit and governed
- [ ] The learnings are written back into knowledge

## 5. How to Improve Learning Accuracy

If you want the pipeline learning process to become more precise, focus on these levers.

### 5.1 Increase signal quality

Prefer real inputs, not mock ones.

The better the evidence, the better the downstream synthesis.

### 5.2 Reduce degrees of freedom

Limit early variation:

- one browser session
- one source
- one output contract
- one artifact path

### 5.3 Compare structure, not only prose

Good evaluation looks at:

- section ordering
- field presence
- artifact completeness
- repeated patterns

Do not judge only by how polished the prose sounds.

### 5.4 Make the abstraction boundary visible

When a pipeline is really a composition of actuators, keep the composition explicit.

This is especially important for:

- browser-driven extraction
- reasoning-driven synthesis
- code artifact generation
- multi-step media workflows

### 5.5 Store failures as reusable knowledge

Every failure should answer one of these:

- What broke?
- Why did it break?
- Which contract was violated?
- What rule would have prevented it?
- How do we test for it next time?

## 6. Practical Rule of Thumb

If a pipeline can be expressed as:

1. acquire evidence
2. normalize context
3. synthesize output
4. write artifact
5. compare and validate

then it is probably in the right shape.

If it requires many hidden branches, ad hoc temp files, or ambiguous session ownership, it needs to be simplified before it is learned from.

## 7. Minimal ADF Checklist

Use this when drafting a new pipeline.

- [ ] The pipeline has one clear output artifact
- [ ] The input variables are named and bounded
- [ ] The step types are canonical
- [ ] Every `{{variable}}` can be resolved at runtime
- [ ] The browser or external session has a stable session id
- [ ] The save step uses a supported write operator
- [ ] The pipeline can be run with a real input
- [ ] The output can be reviewed without opening source code
- [ ] The artifact path is root-scoped and governed
- [ ] The pipeline is safe to rerun

## 8. Browser-ADF Starter Shape

Use this skeleton for site/theme extraction, navigation, or other browser-driven workflows.

```json
{
  "pipeline_id": "browser-workflow-example",
  "version": "1.0.0",
  "description": "Template for a browser-driven ADF pipeline.",
  "action": "pipeline",
  "steps": [
    {
      "id": "open-site",
      "type": "control",
      "op": "browser:open_tab",
      "params": {
        "url": "{{source_url}}",
        "waitUntil": "domcontentloaded",
        "keep_alive": true,
        "select": true
      }
    },
    {
      "id": "capture-page",
      "type": "capture",
      "op": "browser:snapshot",
      "params": {
        "export_as": "page_snapshot"
      }
    },
    {
      "id": "synthesize-insight",
      "type": "transform",
      "op": "reasoning:synthesize",
      "params": {
        "instruction": "Summarize the captured page into a governed structured output.",
        "context": ["{{page_snapshot}}"],
        "export_as": "structured_result"
      }
    },
    {
      "id": "write-output",
      "type": "apply",
      "op": "code:write_artifact",
      "params": {
        "path": "active/shared/tmp/output.json",
        "content": "{{structured_result}}"
      }
    }
  ]
}
```

Recommended rules for browser ADF:

- keep `open_tab` and `snapshot` in the same browser session
- always verify the snapshot URL is not `about:blank`
- prefer `control` for session ownership and `capture` for page state
- write final output through a supported artifact writer

## 9. Good and Bad Examples

Use these comparisons when reviewing a new ADF.

### 9.1 Good: `extract-brand-theme`

The stable shape is:

- `control: browser:open_tab`
- `capture: browser:snapshot`
- `transform: reasoning:synthesize`
- `apply: code:write_artifact`

Why this is good:

- browser ownership is explicit
- the capture step follows the open step in the same session
- the reasoning step receives captured evidence, not raw assumptions
- the save step uses a supported writer and a governed path

Representative pattern:

```json
{
  "id": "browse-site",
  "type": "control",
  "op": "browser:open_tab",
  "params": {
    "url": "{{source_url}}",
    "keep_alive": true,
    "select": true,
    "waitUntil": "domcontentloaded"
  }
}
```

### 9.2 Good: `build-web-concept`

The stable shape is:

- one reasoning pass
- one artifact write
- one output target

Why this is good:

- the concept brief is explicit
- the design theme is optional but injectable
- the runtime is simple enough to rerun and compare
- the output is directly reviewable as HTML

Representative pattern:

```json
{
  "id": "site-structure",
  "type": "transform",
  "op": "reasoning:analyze",
  "params": {
    "instruction": "Define and write a complete HTML document...",
    "export_as": "site_html"
  }
}
```

### 9.3 Bad: session split and wrong writer

This is the pattern that tends to fail:

- `browser:open_tab` marked as `apply` instead of `control`
- `browser:snapshot` executed without the same session being preserved
- `artifact:write_json` used where the runtime only supports `code:write_artifact`
- save path or output contract mismatched to the operator

Why this is bad:

- the session ownership is ambiguous
- the browser state can fall back to `about:blank`
- the artifact write may succeed syntactically but fail semantically
- the pipeline looks valid until runtime, then fails late

### 9.4 Bad: mock-only validation

This is the other common failure mode:

- only synthetic URLs are tested
- snapshot quality is never checked on a real page
- output is judged by prose quality only
- reruns are not compared

Why this is bad:

- the pipeline may appear valid while being non-deterministic
- real browser/runtime problems remain hidden
- the learning signal is too weak to standardize from

### 9.5 Quick review rule

When a pipeline has:

- explicit input
- canonical step types
- one stable session
- supported artifact writes
- real-input smoke tests

it is usually worth standardizing.

When it has:

- hidden session splitting
- unresolved placeholders
- unsupported operator names
- mock-only validation
- ambiguous failure classification

it should be treated as unstable until fixed.

## 10. Review Rubric

Score each category from 0 to 2.

| Category | 0 | 1 | 2 |
|---|---|---|---|
| Input quality | mock or ambiguous | partially real | real and representative |
| Contract clarity | unclear | partially defined | explicit and testable |
| Runtime stability | inconsistent | mostly stable | deterministic enough to rerun |
| Artifact quality | incomplete | usable but rough | review-ready |
| Governability | undocumented | partially documented | fully documented and tier-safe |
| Reusability | one-off only | partially reusable | parameterized and portable |
| Failure clarity | opaque or misleading | partially classifiable | load vs runtime vs operator failures are distinguishable |

### Interpretation

- `0-4`: not ready for learning or reuse
- `5-8`: useful, but needs stabilization
- `9-12`: strong candidate for standardization

## 11. Related Template

For a copy-ready starting point, see [`adf-pipeline-template.md`](knowledge/public/orchestration/adf-pipeline-template.md).

---
*Status: Living guidance for ADF pipeline construction and refinement*
