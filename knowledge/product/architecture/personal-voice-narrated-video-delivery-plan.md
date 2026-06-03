---
title: Personal Voice Narrated Video Delivery Plan
category: Architecture
tags: [voice, video, narration, cloning, design-system, rendering, planning]
importance: 9
author: Ecosystem Architect
last_updated: 2026-04-19
---

# Personal Voice Narrated Video Delivery Plan

## Executive Verdict

Yes.

If the request is:

`Use my voice as the base, generate narration, and create a Kyberion introduction movie`

then Kyberion currently completes only part of the scenario.

What worked in the simulation:

- narration artifact generation
- video composition bundle generation
- queue and status observation

What did not complete:

- real personal-voice cloning
- design-system-driven scene generation
- final backend render to an `mp4` artifact

So the correct interpretation is:

- voice registration is required for true personal-voice output
- it is not required for generic fallback narration
- the movie scenario needs an explicit end-to-end delivery path, not only separate voice and video foundations

## Simulation Findings

The simulation exposed three concrete gaps.

### 1. Personal Voice Was Not Actually Used

The request was routed with:

- `profile_id = shadow-multilingual-clone`
- `engine_id = open_voice_clone`

but runtime resolved to:

- `resolved_engine_id = local_say`

That means Kyberion produced a narrated artifact, but not a voice clone.

The underlying reason is structural:

- the clone profile is still `shadow`
- the clone engine is still `shadow`
- the referenced sample asset was not present
- there is no explicit registration or promotion flow for user-provided voice samples

Conclusion:

- for "use my voice" scenarios, voice registration is a required governed phase
- for "just narrate this" scenarios, registration is optional because the system can fall back to a generic voice

### 2. Video Composition Was Prepared But Not Designed

The system successfully compiled:

- `index.html`
- `render-plan.json`
- scene HTML files

But the content was manually authored in the simulation contract.

There is not yet a governed path that says:

- inspect Kyberion's design system or brand assets
- derive scene blocks from those assets
- bind script and narration timing into the composition
- validate that the resulting movie remains on-brand

Conclusion:

- the missing piece is not only rendering
- it is a planning/compiler layer between brand or design-system inputs and `video-composition-adf`

### 3. Backend Rendering Timed Out

When backend rendering was enabled with `hyperframes_cli`, the job timed out and no `mp4` was produced.

That exposes two problems:

- the actuator wait model is still too short and too naive for real renders
- backend readiness and render completion are not yet governed strongly enough

Conclusion:

- "render enabled" is not sufficient
- Kyberion needs a proper long-running producer path with readiness gates, async completion, and backend-specific health checks

## Design Principle

The full scenario should be treated as one governed delivery pipeline:

`voice registration -> narration generation -> script/storyboard/design binding -> composition compile -> deterministic render -> evidence and artifact delivery`

Kyberion should not expect the operator to manually bridge those layers.

## Target Scenario

The target operator experience should be:

`Use my registered voice and create a Kyberion intro movie based on the current design system`

The system should then:

1. verify a usable voice profile exists
2. fail with a precise missing-input message if no approved voice sample is registered
3. gather design-system inputs and brand assets
4. generate script, storyboard, and narration timing
5. synthesize narration using the registered profile
6. compile a governed `video-composition-adf`
7. render the movie asynchronously without CLI timeout failure
8. return final artifact paths plus diagnostics and evidence

## Required Implementation Tracks

## Track 1. Voice Registration And Promotion

### Goal

Make "use my voice" a real capability instead of a shadow-profile placeholder.

### Work

- add a governed `voice-profile-registration` contract
- add a secure sample-ingestion path for user voice assets
- add validation for:
  - minimum sample duration
  - accepted formats
  - language coverage
  - sample count
  - audio quality thresholds
- add a profile state machine:
  - `draft`
  - `validated`
  - `shadow`
  - `active`
  - `disabled`
- add explicit engine compatibility checks before promotion
- add profile evidence and approval records

### Deliverables

- `voice-profile-registration.schema.json`
- `voice-sample-ingestion-policy.json`
- profile promotion procedure
- sample validation runtime

### Acceptance Criteria

- a user sample can be registered through a governed contract
- registration fails clearly when required samples are missing or invalid
- an approved personal profile can be resolved without falling back to `local_say`

## Track 2. Voice Engine Activation And Clone Routing

### Goal

Ensure clone-capable engines are routed intentionally rather than silently downgraded.

### Work

- extend voice engine registry with readiness and dependency diagnostics
- distinguish:
  - `requested_engine_id`
  - `resolved_engine_id`
  - `fallback_reason`
  - `clone_capability_status`
- require explicit policy for whether fallback is allowed on personal-voice requests
- add a strict mode:
  - if request says "use my voice", generic fallback must fail unless explicitly allowed
- add health probes for clone backends and model assets

### Deliverables

- voice engine health probe
- strict-routing policy for personal-voice requests
- clearer status packet and failure packet fields

### Acceptance Criteria

- personal-voice requests either use a clone-capable engine or fail explicitly
- silent downgrade to system TTS no longer happens for strict personal-voice scenarios

## Track 3. Script, Storyboard, And Design-System Binding

### Goal

Turn design-system and brand inputs into a governed movie plan rather than hand-authored scene JSON.

### Work

- define a `narrated-video-brief` contract
- add a compiler that derives:
  - script
  - scene list
  - storyboard beats
  - narration timing
  - template selections
- add design-system ingestion inputs:
  - theme tokens
  - logos
  - typography choices
  - motion rules
  - layout presets
- map design tokens into video template rendering variables
- add brand-validation checks before render start

### Deliverables

- `narrated-video-brief.schema.json`
- `video-storyboard.schema.json`
- design-system-to-video token bridge
- governed Kyberion intro template pack

### Acceptance Criteria

- the operator can request a Kyberion intro movie without manually authoring every scene
- generated scene composition stays within declared brand and layout rules

## Track 4. Narration Timing And Audio Binding

### Goal

Make narration duration a first-class input to scene timing.

### Work

- add transcript timing output from voice generation
- add per-chunk and per-sentence timing records
- bind timing records into scene duration planning
- allow caption and subtitle artifact generation from the same transcript
- detect mismatch between narration duration and composition duration before render

### Deliverables

- narration timing artifact
- caption/subtitle generation path
- duration reconciliation validator

### Acceptance Criteria

- scene timing is derived from actual narration timing, not only static estimates
- render is blocked if audio and scene durations drift beyond policy thresholds

## Track 5. Deterministic Backend Render Producer

### Goal

Replace the current timeout-prone render bridge with a real producer path.

### Work

- separate `bundle preparation` from `render production`
- move backend render to a long-running async job model
- add backend-specific readiness gates:
  - runtime boot
  - asset staging complete
  - composition ready
  - frame seek ready
  - encoder ready
- add job heartbeat and producer-side timeout ownership
- add output verification:
  - file exists
  - file size threshold
  - media metadata probe
  - optional frame count validation
- mux narration into the final video artifact instead of leaving audio as a detached reference
- persist render logs and backend diagnostics

### Deliverables

- dedicated producer runtime or `video-render-actuator`
- render readiness contract
- artifact verification helper
- backend log capture

### Acceptance Criteria

- final `mp4` creation does not depend on a short synchronous CLI wait loop
- the final artifact is audio-muxed when narration is available
- render jobs survive long-running execution and expose observable status until completion

## Track 6. End-To-End Operator Scenario

### Goal

Make the full user request executable as one top-level scenario.

### Work

- define a canonical scenario:
  - `create_narrated_intro_movie`
- required inputs:
  - approved voice profile or registration request
  - source brief
  - design-system or brand reference
  - desired output format
- add scenario-level preflight
- add explicit missing-input reporting
- add final delivery record that links:
  - voice artifact
  - transcript
  - storyboard
  - composition bundle
  - rendered movie

### Deliverables

- scenario contract
- scenario procedure
- golden scenario tests

### Acceptance Criteria

- the operator can ask once and receive either a completed movie or a precise missing-input contract

## Policy Decision: Is Voice Registration Required First?

For a strict interpretation of:

`Use my voice`

the answer is:

- yes, registration is required first

Because Kyberion needs:

- approved voice samples
- an active clone-capable profile
- a non-fallback engine route

For a weaker interpretation of:

`Create narrated audio`

the answer is:

- no, registration is not required

Because a generic governed narration voice is sufficient.

So Kyberion should implement this explicit rule:

- if the operator requests `my voice`, registration is mandatory unless an active approved personal profile already exists
- if the operator requests only narration quality or language, fallback to a governed generic voice is allowed

## Recommended Delivery Order

### Phase 1. Make Personal Voice Real

- implement voice registration and validation
- implement strict personal-voice routing policy
- fail explicitly when clone prerequisites are missing

### Phase 2. Make Design Binding Real

- implement narrated video brief
- implement script/storyboard/design-system compiler
- add Kyberion intro template pack

### Phase 3. Make Rendering Reliable

- introduce async backend render producer
- add readiness gates and output verification
- remove synchronous timeout dependence from final render success

### Phase 4. Make The Whole Scenario One Contract

- add top-level narrated intro movie scenario
- add end-to-end golden tests
- add operator-facing missing-input and completion receipts

## Immediate Backlog Tasks

- add `voice-profile-registration` foundation and sample validation
- promote clone routing from shadow-only concept to governed active path
- add strict no-fallback mode for personal-voice requests
- add transcript timing output to voice generation
- add narrated-video brief compiler with design-system input binding
- add async render producer with backend health checks
- add output media verification after render
- add one end-to-end golden scenario for `personal voice + Kyberion intro movie`

## Success Condition

This scenario is complete when Kyberion can honestly do all of the following:

- detect whether the operator's voice is already registered
- request registration only when truly necessary
- generate narration using the approved personal profile
- bind the current design system into a governed intro-movie composition
- render a final movie artifact without timing out in the CLI wait loop
- return evidence and diagnostics for the whole chain
