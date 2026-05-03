# Capability Bundle Model

Kyberion does not need a new umbrella schema immediately for the concept
that corresponds to Hermes-style skills. The better fit is a governed
capability bundle layered on top of the existing actuator and pipeline
contracts.

## Decision

Use the existing `actuator-pipeline-bundle` family as the runtime-facing
carrier, and connect it to the current registries instead of introducing a
large new top-level schema.

The reason is simple:

- Kyberion already treats `actuator` as the smallest execution primitive.
- Kyberion already treats `pipeline` as the execution sequence.
- Kyberion already has intent, outcome, task-session, and capability
  registries that cover the rest of the lifecycle.

The missing piece is not a new primitive. It is a catalog-level wrapper
that says: "this is a reusable capability made of actuators, pipelines,
governance, and documentation."

## Recommended Shape

Treat a capability bundle as a catalog entry with the following fields:

- `name`
- `description`
- `intents`
- `required_actuators`
- `pipelines`
- `outcomes`
- `tier`
- `approval_requirements`
- `references`

Runtime should still execute only through:

- `actuator`
- `pipeline`

The bundle itself is a governed packaging concept, not a new execution
primitive.

## Existing Contracts To Reuse

| Role | Existing contract |
|---|---|
| User request normalization | [`intent-contract.schema.json`](../schemas/intent-contract.schema.json) |
| Candidate resolution | [`intent-resolution-packet.schema.json`](../schemas/intent-resolution-packet.schema.json) |
| Execution bundle | [`actuator-pipeline-bundle.schema.json`](../schemas/actuator-pipeline-bundle.schema.json) |
| Executable plan | [`actuator-resolution-plan.schema.json`](../schemas/actuator-resolution-plan.schema.json) |
| Runtime session state | [`task-session.schema.json`](../schemas/task-session.schema.json) |
| External capability catalog | [`harness-capability-registry.schema.json`](../schemas/harness-capability-registry.schema.json) |
| Outcomes | [`../governance/outcome-catalog.json`](../governance/outcome-catalog.json) |

## Why Not Add A New Large Schema Yet

A new top-level schema would duplicate fields that already exist in the
intent, task-session, and harness registries. That would create another
compatibility surface without adding much value.

The existing bundle schema is already the right place to represent:

- the bundle's archetype
- the set of jobs
- the per-job actuator
- the per-job template path
- the recommended procedure
- parameter overrides

That is enough for most reusable capability packaging.

## When A New Schema Is Justified

Create a new `capability-bundle.schema.json` only if all of the following
are true:

- the bundle must be first-class in multiple surfaces, not just in
  orchestration
- the bundle needs its own lifecycle independent of execution bundles
- the bundle must express both documentation and runtime affordances in a
  way that cannot fit `actuator-pipeline-bundle`
- the bundle needs stable public exchange with other systems

If that happens, keep the new schema thin and make it reference the
existing contracts rather than re-modeling them.

## Integration Plan

### Phase 1

Extend the meaning of `actuator-pipeline-bundle` to cover the capability
bundle use case.

### Phase 2

Link bundle catalog entries into the intent and harness registries.

### Phase 3

Use the bundle as the source of truth for reusable actuator-plus-pipeline
capabilities, while keeping runtime execution inside the actuator and
pipeline layers.

### Phase 4

Introduce a dedicated `capability-bundle.schema.json` only if a real
boundary appears that cannot be represented with the existing contracts.

## Practical Rule

If a field describes execution, keep it in actuator / pipeline contracts.

If a field describes discoverability, placement, or reuse, keep it in the
bundle/catalog layer.

If a field describes user-facing intent, keep it in intent and task-session
contracts.

## Progressive Disclosure

Capability bundles should be presented in two layers:

- **summary layer**: bundle id, status, capability area, and the most relevant actuators or harness references
- **detail layer**: full registry entry, references, source bundle path, and the broader intent list

The default display should be the summary layer. Expand to the detail
layer only when the operator, workflow, or audit step explicitly needs it.

This rule is documented operationally in
[`capability-bundle-progressive-disclosure.md`](../orchestration/capability-bundle-progressive-disclosure.md).

## Concrete Example

The following `actuator-pipeline-bundle` is already a valid runtime bundle
shape in Kyberion:

```json
{
  "kind": "actuator-pipeline-bundle",
  "archetype_id": "generative-video-from-adf",
  "status": "ready",
  "summary": "Generate a governed country-drive video clip from a video-generation-adf contract through media-generation-actuator.",
  "jobs": [
    {
      "id": "generate-drive-clip",
      "title": "Generate Drive Clip From Video ADF",
      "actuator": "media-generation-actuator",
      "template_path": "libs/actuators/media-generation-actuator/examples/video-adf-drive-clip.json",
      "recommended_procedure": "knowledge/public/procedures/media/generate-video-from-adf.md",
      "parameter_overrides": {
        "params": {
          "video_adf": {
            "intent": "country_drive_campaign_clip"
          }
        }
      },
      "outputs": [
        "active/shared/exports/KyberionDriveClip.mp4"
      ]
    }
  ]
}
```

In capability-bundle language, that same object can be read as:

- `name`: `Generate Drive Clip From Video ADF`
- `description`: `Generate a governed country-drive video clip from a video-generation-adf contract through media-generation-actuator.`
- `intents`: `country_drive_campaign_clip`
- `required_actuators`: `media-generation-actuator`
- `pipelines`: `video-adf-drive-clip`
- `outcomes`: `active/shared/exports/KyberionDriveClip.mp4`
- `tier`: governed public execution, subject to the procedure and the
  surrounding mission tier
- `approval_requirements`: whatever the mission / pipeline policy requires
- `references`: the template path and recommended procedure

The important point is that the bundle does not add a new runtime engine.
It gives a stable catalog surface that points to the existing actuator and
pipeline execution model.

## Connection To The Harness Capability Registry

The harness capability registry describes host-native capabilities that
Kyberion may route to through adapters.

The capability bundle describes Kyberion-governed reusable packages made
of local actuators, pipelines, policies, and references.

They should stay distinct:

- `harness-capability-registry` answers "what can the host provide?"
- `capability bundle` answers "what governed Kyberion package can we reuse?"

The current example registry lives at
[`knowledge/public/governance/capability-bundle-registry.json`](../governance/capability-bundle-registry.json).

When a capability bundle depends on a host-native surface, the bundle
should reference the relevant harness capability entry instead of
redefining it.

Practical mapping:

| Layer | Example responsibility |
|---|---|
| Harness capability registry | Declare a host-native browser, model, or delegated execution surface |
| Capability bundle | Wrap Kyberion actuators and pipelines that use that surface in a governed way |
| Intent contract | Decide whether the user request should route into that bundle |
| Task session | Track the live execution state, missing inputs, and artifacts |

If a future bundle needs to point at a host-native surface, the bundle can
carry the registry reference in `references` or `notes`, while the harness
registry continues to own risk, replayability, and fallback metadata.

### Worked Example: Browser Exploration

The harness registry already contains the host-native browser surface:

- `cli.native.browser_interactive`

A corresponding Kyberion capability bundle could look like this:

```json
{
  "kind": "actuator-pipeline-bundle",
  "archetype_id": "browser-exploration-governed",
  "status": "ready",
  "summary": "Explore a website through the host browser surface, then distill the findings into a governed Kyberion artifact.",
  "jobs": [
    {
      "id": "browser-explore-and-report",
      "title": "Explore Site And Produce Findings",
      "actuator": "browser-actuator",
      "template_path": "knowledge/public/procedures/browser/explore-and-report.json",
      "recommended_procedure": "knowledge/public/procedures/browser/explore-and-report.md",
      "parameter_overrides": {
        "params": {
          "target_capability_id": "cli.native.browser_interactive",
          "expected_behavior": "interactive_loop"
        }
      },
      "outputs": [
        "knowledge/confidential/evaluations/browser-findings.md"
      ]
    }
  ]
}
```

Capability-bundle reading:

- `required_actuators`: `browser-actuator`
- `pipelines`: `explore-and-report`
- `references`: `cli.native.browser_interactive`
- `outcomes`: a governed findings artifact
- `tier`: confidential, because the output path is confidential

In other words, the bundle does not reinvent browser access.
It wraps the browser surface with Kyberion policy, evidence, and artifact
placement rules.

## Kyberion-Specific Naming Guidance

Do not reuse `skill` as a first-class internal runtime term. It is already
loaded with meaning from external platforms.

Prefer:

- `capability bundle`
- `playbook`
- `execution bundle`
- `governed capability`

The user-facing surface can still say "できること" or "capability catalog"
without forcing the runtime to mirror platform-specific naming.
