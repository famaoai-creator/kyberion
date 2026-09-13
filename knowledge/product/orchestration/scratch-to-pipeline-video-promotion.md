---
title: Scratch-to-Pipeline Video Promotion
kind: howto
scope: repository
authority: reference
phase: [execution, review]
tags: [video, scratch-first, pipeline, promotion, narrated]
owner: ecosystem_architect
last_updated: 2026-09-13
---

# Scratch-to-Pipeline Video Promotion

## What this is

After a **scratch** narrated clip is accepted, promote the winning content into the governed narrated-video path so the next run is replayable and publish-gated.

Parent playbook: [`narrated-video-production-playbook.md`](./narrated-video-production-playbook.md)

## When to promote

Promote only when **all** of these are true:

1. An operator watched the scratch MP4 and accepted the picture / VO (or asked explicitly to promote).
2. Scene titles, supporting lines, and beat order are stable.
3. Output length and language are settled.
4. You need reuse, CI/validation, or a publish boundary — not another discovery pass.

If the look is still changing, stay in scratch.

## What to carry over

From the accepted scratch source (for example `scripts/kyberion_intro_scratch.ts` + `active/shared/tmp/...`):

| Scratch artifact        | Pipeline target                                                    |
| ----------------------- | ------------------------------------------------------------------ |
| Per-scene VO lines      | `script.hook` / `feature` / `cta` and/or storyboard `message`      |
| Short on-screen titles  | storyboard `beat.title` (keep short; do not paste full VO)         |
| Supporting lines        | storyboard `visual_intent` / scene `body` (must differ from title) |
| Step labels             | storyboard process beats or `visual_steps`                         |
| Palette / type / layout | `design_system` / preference profile theme                         |
| Duration per beat       | storyboard `duration_sec` + voice artifact timing                  |
| Final scratch MP4 path  | evidence reference only (do not commit binary to git)              |

## Promote steps

1. Copy the accepted scene table into a `narrated-video-brief` + optional explicit `storyboard` (prefer explicit beats over legacy synthesis).
2. Generate narration with `voice:generate_voice` into a governed temp/mission path.
3. Render with `video-composition:create_narrated_intro_movie` or `create_narrated_video_from_content_brief`.
4. Validate the artifact (`validate_narrated_video_artifact` / ffprobe).
5. Register a dedicated `pipelines/<slug>.json` only if the clip will be re-run; otherwise keep the brief under mission evidence.
6. Leave publication on a separate gate.

## Do not promote

- Unreviewed scratch frames
- Duplicate headline/body copy that was only “good enough” in scratch
- English template leftovers (`Ordered steps`, etc.)
- One-off experiments that will not be replayed

## Scratch entry points

- Example scratch renderer: `scripts/kyberion_intro_scratch.ts`
- Output root pattern: `active/shared/tmp/<slug>-scratch` (governed temp; never a top-level `scratch` directory)
