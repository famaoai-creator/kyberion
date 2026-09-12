---
title: Narrated Video Production Playbook
kind: playbook
scope: repository
authority: reference
phase: [alignment, execution]
tags: [video, narrated, scratch-first, pipeline, orchestration]
owner: ecosystem_architect
last_updated: 2026-09-13
---

# Narrated Video Production Playbook

Use this playbook when the user asks for a narrated product video, a tutorial clip, a promotional video, or a video that may later be uploaded to YouTube.
It specializes the shared [Guided Coordination Protocol](knowledge/product/orchestration/guided-coordination-protocol.md) for narrated media work.

## Default production shape: scratch first, pipeline second

**Standard flow for new narrated clips:**

1. **Scratch prototype** — author scenes and narration outside the ADF / video-composition pipeline until the picture and VO feel right.
2. **Human accept** — watch the scratch MP4; adjust titles, layout, pacing, and copy in the scratch script.
3. **Pipeline promote** — only after acceptance, encode the winning brief / storyboard / theme into a governed pipeline (or catalog procedure) for replay, validation, and publish gates.

Do **not** start a first draft inside `create_narrated_intro_movie` / `video-content-brief` when the visual language is still unknown. Those paths optimize for reuse and governance, not for discovery.

Reference scratch entry point: [`scripts/kyberion_intro_scratch.ts`](../../../scripts/kyberion_intro_scratch.ts)  
Promotion checklist: [`scratch-to-pipeline-video-promotion.md`](./scratch-to-pipeline-video-promotion.md)

## Kyberion Fit

Video production should be handled as a coordination flow, not as a direct answer.
The value is in brief capture, audience fit, visual theme selection, asset constraints, and a visible publish boundary.

Use Kyberion when the task has at least one of these properties:

1. It needs a narrated video, teaser, walkthrough, or launch clip.
2. It depends on audience, tone, or brand style.
3. It should produce reusable script, scene, and thumbnail assets.
4. It might be uploaded to YouTube or another public channel.

If the request is prompt-based rather than narrated, route it through
[`generate-video-from-adf.md`](knowledge/public/procedures/media/generate-video-from-adf.md)
instead of the narrated composition flow.

## Brief And Theme Separation

Keep two layers distinct inside the shared coordination flow:

1. Brief layer: what the video is about, who it is for, and what action it should drive.
2. Theme layer: how the video should look and move.

Use `narrated-video-preference-profile` to store the reusable theme, the first questions Kyberion should ask, and the publish policy.

Scratch prototypes may invent theme temporarily; on promote, lock the accepted theme into the preference profile or the pipeline `design_system` / storyboard.

## Preflight

Before drafting the script or composition, decide which brief questions and theme to use.

1. Read the stored `narrated-video-preference-profile`.
2. Pick the brief question set that matches the video purpose.
3. Pick the theme set that matches the same purpose and audience.
4. Ask only the first 1-3 questions that would materially change the script, scene order, or publish boundary.

Keep this preflight short. It should decide how to frame the video, not write the entire script.

Good fits for this preflight include tutorial videos, product intros, onboarding clips, marketing teasers, and launch announcements.

## Workflow

### A. Scratch loop (default for first render)

1. Intent capture: preserve the original request and extract known facts.
2. Clarification pass: ask only the questions that change audience, runtime, language, or publish boundary.
3. Scratch authoring: custom scenes + narration (HTML/Playwright/ffmpeg or equivalent), under `active/shared/tmp/`.
4. Watch + revise: fix redundant titles, weak hierarchy, and pacing in the scratch source — not in the pipeline yet.
5. Stop when the operator accepts the scratch MP4 (or explicitly asks to promote).

### B. Pipeline promote (after acceptance)

1. Brief draft: lock goal, audience, runtime, sources, and constraints from the accepted scratch.
2. Theme selection: encode the accepted look into profile / `design_system` / storyboard beats (short titles, distinct body).
3. Composition: compile into a `video-composition-adf` or a dedicated `pipelines/*.json`.
4. Generate + validate: render through video-composition / voice actuators and run artifact validation.
5. Approval: pause before upload or public publish if visibility, licensing, or brand risk needs confirmation.
6. Publish preparation: `narrated-video-publish-plan` when external distribution is in scope.
7. Review: propose reusable preference updates for `knowledge/personal/` only when the user approves.

## Nearby Media Surfaces

- [`scratch-to-pipeline-video-promotion.md`](./scratch-to-pipeline-video-promotion.md)
- [`generate-video-from-adf.md`](knowledge/public/procedures/media/generate-video-from-adf.md)
- [`transcribe-audio-from-asset.md`](knowledge/public/procedures/media/transcribe-audio-from-asset.md)
- [`realtime-voice-conversation.md`](knowledge/public/procedures/media/realtime-voice-conversation.md)

## Publish Boundary

Treat publication as a separate gate from rendering. Scratch acceptance is **not** publication approval.

Safe defaults:

- allow scratch and pipeline renders to complete locally
- prepare an unlisted or draft upload only if the profile allows it
- require human approval before public release
- stop if thumbnail, description, caption, or rights are missing

## Outputs

Minimum output (scratch stage):

1. Scratch MP4 path under `active/shared/tmp/`.
2. Scene list (titles + VO lines).
3. Open questions that still block promote or publish.

Full output (after promote):

1. Narrated video brief / storyboard locked from the accepted scratch.
2. Theme selection summary.
3. Pipeline (or procedure) entry point.
4. Final governed video artifact, with narration muxed when available.
5. Publish package and approval preview when needed.
6. Personal preference update proposal when the user approves.
