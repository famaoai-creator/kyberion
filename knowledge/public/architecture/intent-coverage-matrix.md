# Intent Coverage Matrix

## Purpose

This document tracks how far each user-facing intent is connected through the Kyberion stack:

`Intent -> Context -> Work -> Outcome -> Authority -> Evidence -> Memory`

It exists to prevent drift between:

- the user-facing intent catalog
- runtime routing and task creation
- actuator and pipeline execution
- approval, evidence, and memory loops

For the canonical completion pattern of each surface intent, see:

- [intent-outcome-patterns.md](/Users/famao/kyberion/knowledge/public/architecture/intent-outcome-patterns.md)
- [intent-outcome-patterns.json](/Users/famao/kyberion/knowledge/public/governance/intent-outcome-patterns.json)

## Coverage Levels

- `implemented`
  The intent resolves through a stable runtime path and reaches a governed outcome.
- `partial`
  The intent works, but the path is still route-specific, incomplete, or weakly normalized.
- `missing`
  The catalog entry exists, but runtime or actuator coverage is not first-class yet.

## Matrix

| Intent | Status | Entry Path | Work Shape | Outcome | Notes |
|---|---|---|---|---|---|
| `bootstrap-project` | `implemented` | `voice-hub` | `project_bootstrap` | `project_created` | Creates project record, kickoff task session, bootstrap work items, mission seeds |
| `generate-presentation` | `implemented` | `voice-hub` + `task-session` | `task_session` | `artifact:pptx` | Brief and media pipeline are wired to governed artifact output |
| `generate-report` | `implemented` | `voice-hub` + `task-session` | `task_session` | `artifact:docx` / `artifact:pdf` | Report brief and document artifact generation are connected |
| `generate-workbook` | `implemented` | `voice-hub` + `task-session` | `task_session` | `artifact:xlsx` | Workbook/WBS flow is connected to governed artifact output |
| `inspect-service` | `implemented` | `voice-hub` + `task-session` | `task_session` | `service_summary` / `approval_request` | Service inspection and approval-aware operation path exist |
| `open-site` | `partial` | `voice-hub` browser path | `browser_session` | `browser_navigation` | Works, but not yet unified with task-session style catalog-first runtime routing |
| `browser-step` | `partial` | `voice-hub` browser path | `browser_session` | `browser_step` | Works, but still route-specific |
| `knowledge-query` | `partial` | direct reply path | `direct_reply` | `knowledge_answer` | Available, but resolver path is not yet fully catalog-first |
| `cross-project-remediation` | `partial` | `task-session` classifier | `task_session` | `remediation_plan` | Natural-language bug propagation review can be normalized into governed analysis work, but automatic fix fan-out is not first-class yet |
| `incident-informed-review` | `partial` | `task-session` classifier | `task_session` | `review_findings` | Prior-incident-aware review can be normalized into governed analysis work, but review target binding and execution are still incomplete |
| `evolve-agent-harness` | `partial` | `task-session` classifier | `task_session` | `harness_experiment_report` | Benchmark-driven harness evolution is modeled as governed analysis, but benchmark runners and keep or discard ledgers are not yet first-class runtime contracts |
| `live-query` | `partial` | direct reply path | `direct_reply` | `live_answer` | Available, but runtime coverage is less normalized than core work flows |

## What Is Strong

- document and artifact generation
- project bootstrap and mission seed flow
- approval handling across Presence, Chronos, and CLI
- evidence and memory loop persistence

## What Is Weak

### Catalog Drift

The catalog in [standard-intents.json](/Users/famao/kyberion/knowledge/public/governance/standard-intents.json) is more complete than the runtime entry points.

Examples:

- browser intents are not resolved through the same task-session path as document intents
- live and knowledge queries still use more route-specific runtime handling

### Outcome Drift

[work-design.ts](/Users/famao/kyberion/libs/core/work-design.ts) can reason about outcomes that should always be declared in [outcome-catalog.json](/Users/famao/kyberion/knowledge/public/governance/outcome-catalog.json).

### Execution Taxonomy Drift

[super-nerve](/Users/famao/kyberion/libs/actuators/orchestrator-actuator/src/super-nerve/index.ts) still relies on a hand-maintained action classification list for `capture / transform / apply`.

### Visual Capability Split

Structured visual generation is improving:

- `document_diagram_render_from_brief`
- `pptx_render`
- governed document output

But freeform image generation is still not a first-class governed capability.

### Service Binding Resolution

Service bindings are persisted and visible, but natural-language execution is still only partially binding-aware.

### Benchmark Loop Normalization

Harness-improvement work can now be described in the intent catalog, but runtime still treats it like generic analysis work.

What is still missing:

- benchmark execution as a first-class governed contract
- explicit experiment ledgers with baseline and rerun deltas
- enforceable protected edit boundaries for harness evolution

## Priority Backlog

1. Make the standard intent catalog the single runtime source of truth.
2. Normalize the outcome catalog so runtime never references undeclared outcomes.
3. Replace hand-maintained super-nerve action classification with a shared op registry.
4. Push service-binding-aware execution into resolver/runtime, not just storage and UI.
5. Split visual generation clearly into:
   - governed diagram/document visual
   - generative image visual
6. Add contract tests for each surface intent:
   - input
   - resolved shape
   - expected outcome
   - actual actuator path

## Current Interpretation

Kyberion already has a strong primary work loop:

- project bootstrap
- artifact generation
- approvals
- evidence
- memory reuse

The next phase is not invention of a new model.
It is reducing runtime drift so the catalog, resolver, actuator path, and evidence model are consistently aligned.
