# Narrated Video Production Playbook

Use this playbook when the user asks for a narrated product video, a tutorial clip, a promotional video, or a video that may later be uploaded to YouTube.
It specializes the shared [Guided Coordination Protocol](./guided-coordination-protocol.md) for narrated media work.

## Kyberion Fit

Video production should be handled as a coordination flow, not as a direct answer.
The value is in brief capture, audience fit, visual theme selection, asset constraints, and a visible publish boundary.

Use Kyberion when the task has at least one of these properties:

1. It needs a narrated video, teaser, walkthrough, or launch clip.
2. It depends on audience, tone, or brand style.
3. It should produce reusable script, scene, and thumbnail assets.
4. It might be uploaded to YouTube or another public channel.

## Brief And Theme Separation

Keep two layers distinct inside the shared coordination flow:

1. Brief layer: what the video is about, who it is for, and what action it should drive.
2. Theme layer: how the video should look and move.

Use `narrated-video-preference-profile` to store the reusable theme, the first questions Kyberion should ask, and the publish policy.

## Preflight

Before drafting the script or composition, decide which brief questions and theme to use.

1. Read the stored `narrated-video-preference-profile`.
2. Pick the brief question set that matches the video purpose.
3. Pick the theme set that matches the same purpose and audience.
4. Ask only the first 1-3 questions that would materially change the script, scene order, or publish boundary.

Keep this preflight short. It should decide how to frame the video, not write the entire script.

Good fits for this preflight include tutorial videos, product intros, onboarding clips, marketing teasers, and launch announcements.

## Workflow

1. Intent capture: preserve the original request and extract known facts.
2. Clarification pass: ask only the questions that change the video brief, theme, or publish policy.
3. Brief draft: create a narrated-video brief with goal, audience, runtime, sources, and constraints.
4. Theme selection: choose a theme hint from the profile, or ask if the choice is unclear.
5. Composition: compile the brief into a `video-composition-adf`.
6. Approval: pause before upload or public publish if visibility, licensing, or brand risk needs confirmation.
7. Generate: render the video artifact.
8. Publish preparation: prepare a `narrated-video-publish-plan` with title, thumbnail, description, tags, captions, and visibility.
9. Review: propose reusable preference updates for `knowledge/personal/` only when the user approves.

## Publish Boundary

Treat publication as a separate gate from rendering.

Safe defaults:

- allow the render to complete
- prepare an unlisted or draft upload only if the profile allows it
- require human approval before public release
- stop if thumbnail, description, caption, or rights are missing

## Outputs

Minimum output:

1. Current assumptions and unresolved blocking questions.
2. Brief summary and chosen theme.
3. Composition summary.
4. Publish preview if anything external or high-risk is needed.

Full output:

1. Narrated video brief.
2. Theme selection summary.
3. Composition summary.
4. Final video artifact, with narration muxed when available.
5. Publish package and approval preview.
6. Personal preference update proposal.
