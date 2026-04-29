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
| `schedule-coordination` | `implemented` | `voice-hub` + `task-session` | `task_session` | `schedule_coordination_summary` | Calendar reshuffling is modeled as a governed task-session with a clear meeting handoff boundary |
| `launch-first-run-onboarding` | `implemented` | `voice-hub` + `task-session` | `task_session` | `onboarding_plan` | First-run onboarding is now a reusable intent that can lead into toolchain and theme registration |
| `configure-organization-toolchain` | `implemented` | `voice-hub` + `task-session` | `task_session` | `organization_toolchain_configured` | Onboarding for CI/CD and organization-specific integration settings is now catalog-driven |
| `register-presentation-preference-profile` | `implemented` | `voice-hub` + `task-session` | `task_session` | `presentation_preference_profile_registered` | Presentation theme and brief preferences can be stored as reusable knowledge instead of hard-coded branches |
| `open-site` | `implemented` | `voice-hub` browser path | `browser_session` | `browser_navigation` | Browser requests now route through `browser-operator` before browser-actuator execution |
| `browser-step` | `implemented` | `voice-hub` browser path | `browser_session` | `browser_step` | Browser requests now route through `browser-operator` before browser-actuator execution |
| `knowledge-query` | `implemented` | direct reply path | `direct_reply` | `knowledge_answer` | Knowledge search now routes through the catalog-first direct reply path |
| `clarify-user-request` | `implemented` | `voice-hub` direct reply | `direct_reply` | `clarification_packet` | Missing-input questions are now a first-class conversation intent |
| `continue-conversation` | `implemented` | `voice-hub` direct reply | `direct_reply` | `conversation_reply` | Keeps the active thread coherent without forcing a new task |
| `summarize-conversation` | `implemented` | `voice-hub` direct reply | `direct_reply` | `conversation_summary` | Converts an active exchange into a reusable summary |
| `conversation-to-mission` | `implemented` | `voice-hub` direct reply | `direct_reply` | `mission_brief` | Escalates a thread into a governed mission brief |
| `executive-strategy-brief` | `implemented` | `voice-hub` direct reply | `direct_reply` | `strategy_brief` | CEO strategy comparison now resolves to a named brief |
| `executive-prioritization` | `implemented` | `voice-hub` direct reply | `direct_reply` | `priority_roadmap` | CEO focus and tradeoff requests have a named outcome |
| `executive-reporting` | `implemented` | `voice-hub` direct reply | `direct_reply` | `executive_report` | Executive KPI/reporting summaries are first-class |
| `stakeholder-communication` | `implemented` | `voice-hub` direct reply | `direct_reply` | `stakeholder_message` | Stakeholder message drafting is first-class |
| `sales-account-strategy` | `implemented` | `voice-hub` direct reply | `direct_reply` | `account_strategy_plan` | Customer/account strategy requests are first-class |
| `technical-decision-memo` | `implemented` | `voice-hub` direct reply | `direct_reply` | `technical_decision_memo` | CTO technical decision support is first-class |
| `llm-provider-selection` | `implemented` | `voice-hub` direct reply | `direct_reply` | `provider_selection_report` | Provider/model selection is first-class |
| `agent-runtime-tuning` | `implemented` | `voice-hub` direct reply | `direct_reply` | `runtime_tuning_plan` | Runtime tuning requests resolve to a governed plan |
| `release-readiness-review` | `implemented` | `voice-hub` direct reply | `direct_reply` | `release_readiness_report` | Go/no-go release review is first-class |
| `operator-profile-learning` | `implemented` | `voice-hub` direct reply | `direct_reply` | `operator_learning_update` | Personal adaptation is represented as an explicit learning proposal |
| `cross-project-remediation` | `implemented` | `task-session` classifier | `task_session` | `remediation_plan` | Cross-project remediation now resolves into a governed analysis task-session |
| `incident-informed-review` | `implemented` | `task-session` classifier | `task_session` | `review_findings` | Prior-incident-aware review now resolves into a governed analysis task-session |
| `evolve-agent-harness` | `implemented` | `task-session` classifier | `task_session` | `harness_experiment_report` | Harness evolution now resolves into a governed analysis task-session |
| `live-query` | `implemented` | direct reply path | `direct_reply` | `live_answer` | Live data fetch now routes through the catalog-first direct reply path |

## What Is Strong

- document and artifact generation
- project bootstrap and mission seed flow
- human / LLM conversation orchestration
- schedule coordination as a governed task-session
- CEO/CTO operator harness intents
- first-run onboarding and reusable setup preferences
- onboarding toolchain and presentation preference registration
- approval handling across Presence, Chronos, and CLI
- evidence and memory loop persistence
- repeated coordination work now has a shared `guided-coordination` archetype instead of separate bespoke brief flows

## What Is Weak

### Catalog Drift

The catalog in [standard-intents.json](/Users/famao/kyberion/knowledge/public/governance/standard-intents.json) is now much closer to the runtime entry points.

Examples:

- conversation intents are first-class, but escalation from direct reply into mission work still benefits from a more explicit handoff contract
- onboarding preferences are catalog-driven and the first-run wizard is first-class, but a richer interactive setup surface would still help
- live-query provider selection is still mostly configuration-driven rather than a fully declared intent contract

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

Service bindings are now carried through the shared coordination brief, execution brief, and task-session context. The remaining binding-awareness gap is now mostly in browser_session and direct_reply handler payloads, not the dispatch decision itself.

### Benchmark Loop Normalization

Harness-improvement work now resolves into a governed analysis task-session, but the benchmark loop itself can still be made more explicit.

What is still missing:

- benchmark execution as a first-class governed contract
- explicit experiment ledgers with baseline and rerun deltas
- enforceable protected edit boundaries for harness evolution

## Priority Backlog

1. Make the standard intent catalog the single runtime source of truth.
2. Normalize the outcome catalog so runtime never references undeclared outcomes.
3. Replace hand-maintained super-nerve action classification with a shared op registry.
4. Carry service-binding-aware execution fully into browser_session and direct_reply handler payloads.
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
