---
title: Generative Video Production Playbook
kind: playbook
scope: repository
authority: reference
phase: [alignment, execution, review]
runtime_stages: [planning, execution, review]
role_affinity: [media_producer, ecosystem_architect]
tags: [video, generative, storyboard, budget, provenance, quality, scratch-first]
owner: ecosystem_architect
last_updated: 2026-10-14
---

# Generative Video Production Playbook

Use this alongside the [narrated production flow](narrated-video-production-playbook.md)
when a film contains generated footage: commercials, character films, product shots,
POV sequences, trailers, or generated scenes in a music video. Keep discovery in
scratch; promote an accepted recipe only when it will be reused.

The scene sheet below supports creative planning. The existing video-production
mission also has typed evidence and phase-entry checks, described below. Execute
through existing actuators and validated contracts. Stage acceptance does not grant
provider access, spending authority, or publication approval.

## Production stages and exit evidence

| Stage                | Agent work                                                                                                                                           | Exit evidence                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Script and shot plan | Capture audience, takeaway, runtime, dialogue, actions, camera intent, and audio cues per scene.                                                     | Scene sheet with timed speaker turns and ordered actions; unresolved decisions listed.  |
| Prototype images     | Prepare a character/product reference and representative starting frames. Review identity, hands, product shape, composition, and room for overlays. | Operator accepts the exact image revisions before dependent video generation.           |
| Generate footage     | Choose an available governed backend by shot requirements; submit, save job IDs, wait, collect, and inspect motion.                                  | Selected takes retain their source-image and job references; failed takes have reasons. |
| Audio                | Generate or source voice, music, and SFX; preserve separate assets when available, including intentional silence.                                    | Measured audio lengths and cue times; intelligibility and licensing checked.            |
| Compose and review   | Place footage, exact text, approved logos, and audio through video-composition; inspect sampled frames and play the complete result with sound.      | Artifact validation plus visual and listening review; publication handled separately.   |

Prototype-image acceptance is a production checkpoint, not an approval-store
replacement. Record the operator's decision and the revision it covers. If a source
image changes, review it again before generating dependent footage. For an accepted
recipe, reuse its recorded references instead of asking the same questions again.

For image-to-video, verify that the selected backend/workflow actually accepts a
reference image and that the submitted request carries it. The current
[video-generation ADF](../schemas/video-generation-adf.schema.json) has no canonical
reference-image field. A text-only workflow must not be described as preserving an
accepted reference. Use an existing compatible workflow or report the capability
missing; do not invent provider parameters.

## Plan spend before generating

For every scene record model/workflow, duration, resolution, number of candidates,
maximum attempts, and a current quoted cost per attempt. Record the quote source,
check time, and currency or credit unit. Unknown cost stays unknown; ask for a cap
or use a local/available alternative instead of presenting a guessed total.

Estimate the upper bound as the sum of each scene's cost per attempt multiplied by
its maximum attempts, plus image/audio generation and composition costs where
applicable. Maximum attempts includes the first attempt. Show the initial pass and
retake allowance separately, compare against available credit and the authorized
cap, and record actual consumption after collection. Keep credits and currency in
separate totals unless a verified conversion is available.

Before any fresh submission, check remaining allowance. A model comparison also
uses the allowance. A planned retake reserve is not an instruction to generate
extra takes. On a failed or weak take, record the cause and revise the shot or
contract before submitting again. Exhausted allowance stops new submissions;
changing runtime, resolution, model, or cap is a new production decision.

## Reusable scene sheet

Keep one sheet in scoped mission evidence. Put scratch media in the applicable
[storage-layout floor](../architecture/runtime-storage-layout.md), collect durable
assets with writeScopedArtifact, and preserve tier and tenant on references and
review records. Do not put personal/confidential paths in a public sheet.

Copy this outline for each scene:

| Field         | Record                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Identity      | Stable scene ID, revision, genre, intended message.                                                                           |
| Timing        | Start/end, measured voice duration, speaker turns, actions in order, SFX/music/silence cues.                                  |
| Visual intent | Subject and continuity constraints, camera move, lens/look intent, start/end state, overlay safe area.                        |
| Source        | Accepted reference-image artifact ID/path, revision or digest, operator decision and time. Mark text-only shots explicitly.   |
| Generation    | Backend/model/workflow, seed where supported, validated contract artifact reference, job ID, attempt number, quote and spend. |
| Selection     | Collected take artifact reference, accepted/rejected state, defect and repair reason, selected take.                          |
| Composition   | Voice/music/SFX references, exact overlay copy, approved logo reference, resulting scene/render artifact.                     |
| Review        | Reviewer, reviewed revision, frame/time or listening issue, decision, next action.                                            |

Record the chain: reference image → generation job → selected take → composed scene
→ final render. Use immutable versions or digests instead of a mutable latest
filename. Changing an upstream artifact invalidates its dependent selections and
reviews. Reuse unaffected accepted scenes and repair only the affected scene.
Existing job records remain authoritative for execution status; the scene sheet
adds creative selection evidence and does not duplicate the job runtime.

## Choose quality criteria by genre

Compare available backends with the same shot intent and acceptance criteria;
record prompt, model version, settings, output references, defects, and cost. A
comparison of one scene is evidence for that scene, not a universal model ranking.

| Genre                 | Review emphasis                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Dialogue / anime      | Speaker identity, timed turns, overlapping speech, natural pauses, lip/motion coherence.                                   |
| Live action / product | Character and product continuity, hands, lighting/materials, lens/look intent; consider a separate product reference shot. |
| Mascot / character    | Silhouette, colors, accessories, limb count, proportions, consistent identity across takes.                                |
| Game-style sequence   | Ordered player actions, readable state changes, continuity; add exact UI copy during composition.                          |
| POV / transformation  | Explicit start/end states, order of transformation, camera entry point and direction, unintended cuts.                     |
| Trailer / horror      | Timed SFX, intentional silence, dialogue clarity, music balance; retain separate audio assets for repair.                  |
| Motion graphics       | Background/motion intent, exact copy and logo overlays, beat alignment and legibility.                                     |

Generate footage without critical lettering when possible. Place product names,
claims, subtitles, logos, and UI text deterministically during composition. Keep
semantic look decisions in the brief/design defaults; do not bake a third-party
model's misspelled text into the final asset.

## Final review and promotion

1. Validate streams, runtime, and muxed audio through the existing artifact checks.
2. Use `pnpm kyberion watch <artifact> --every <seconds> --max-frames <count>` for
   sampled frames and transcript evidence. Pick a cadence appropriate to the
   shortest shots; a fixed small frame count cannot prove an absence of defects.
3. Inspect key poses, hands, products, scene transitions, overlay changes, and the
   last frame. Sampling can miss motion defects; the operator plays the complete
   video with sound to judge continuity, delivery, and intelligibility.
4. Record the exact reviewed render revision and unresolved defects. Review rights,
   claims, and channel disclosure requirements through the existing publication
   review flow; render acceptance is not public-release approval.
5. On acceptance, carry scene references, selected takes, review criteria, and spend
   limits into [scratch promotion](scratch-to-pipeline-video-promotion.md). Keep
   fresh creative judgments as semantic briefs; promote repeatable wiring only.

## Reference and adoption rationale

Analyzed reference: [Claude/AZ8 video production workflow](https://www.youtube.com/watch?v=9eb3qCWL9Qs),
22m37s, accessed 2026-10-14. Evidence: Japanese automatic captions, parsed with
Kyberion's existing parseVtt, and sampled images extracted by kyberion watch.
Automatic captions can misrecognize names and numbers; timestamps below identify
spoken sections, not verified current provider specifications.

| Reference section | Adopted process improvement                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| 02:59–03:35       | Accept a starting image and estimate generation spend before dependent footage.                             |
| 04:26–04:41       | Preserve the visible dependency from source image to generated clip in the scene sheet.                     |
| 05:50–07:38       | Select a backend using shot-specific expression, camera, continuity, and motion criteria.                   |
| 07:51–10:18       | Keep five production stages and genre-specific reviews while reusing accepted recipes.                      |
| 11:17–19:41       | Time speaker/action/audio cues, maintain character/product references, and composite exact text separately. |
| 19:43–20:28       | Pair frame inspection with full playback/listening and publication review.                                  |
| 20:30–21:33       | Reserve retake spend; do not assume the first generation is the selected take.                              |

Kyberion already separates generation, voice, composition, scratch acceptance,
and public-release approval. This playbook adds the missing per-scene decisions
and their evidence. It does not install AZ8, add a provider, adopt the video's
prices or model ranking as defaults, or claim the tutorial's time savings were
reproduced in Kyberion.

## Connection to the video-production mission

The canonical workflow now expands prototype_assets → prototype_acceptance before
asset_generation, and playback_review before promotion. Existing goal/spec/scene
planning, independent artifact evaluation, partial repair, and publication approval
remain in that workflow. Entry gates use the read-only
scripts/check_video_production_evidence.ts checker; failed checks defer phase
dispatch even when mission exit-gate enforcement is set to warn.

Author the existing mission artifacts using
[video-production-evidence.schema.json](../schemas/video-production-evidence.schema.json):

| Artifact                     | Added structured evidence                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| production-spec.json         | kind=video-production-spec, duration_sec, budget.unit/cap/available/base_cost/max_repair_rounds.                                                                                           |
| scene-plan.json              | kind=video-scene-plan, stable scene_id, duration and semantic content, generation.mode/quote_source/quoted_at/cost_per_attempt/max_attempts, quality_criteria, action_cues and audio_cues. |
| prototype-manifest.json      | kind=video-prototype-manifest, references with scene_id, revision, and mission-relative artifact path plus SHA-256. Only reference_image scenes have entries.                              |
| prototype-acceptance.json    | kind=video-prototype-acceptance, scene_id/request_id references to usable human decisions in the shared approval store.                                                                    |
| asset-manifest.json          | kind=video-asset-manifest, unit/base_spent and per-scene status, selected_take, source_reference, job_id, generation_contract, attempt_count/repair_count/spent, and scene_plan_hash.      |
| video-eval-report.json       | kind=video-eval-report, verdict/flags/repair_rounds, evaluated_render path and SHA-256, scene_plan_sha256, per-scene selected_take_sha256 and criteria_checked.                            |
| video-playback-approval.json | kind=video-playback-approval, request_id for generated footage, or not_required=true for a video whose scenes all use mode=none.                                                           |

All media/contract references in these mission manifests are relative to the
mission directory under evidence/. Store immutable files there through the scoped
artifact writer; other runtime stores and tenant artifacts retain their own
canonical locations. Absolute paths, traversal, symbolic-link escapes, missing
files, and changed bytes do not satisfy these checks.

Use integer amounts in one explicit billing unit, such as credit or usd-cent, to
avoid floating-point currency sums. base_cost is the planned image/audio/composition
and comparison allowance; base_spent is its actual recorded consumption. Video
attempt spend stays on the scene asset entry. Include failed attempts and model
comparisons in consumption, and retain cumulative counts/costs when replacing a
selected take. generation_contract points at the immutable validated submitted
request. scene_plan_hash is computeApprovalPayloadHash of that scene object;
scene_plan_sha256 is SHA-256 of the current scene-plan.json file bytes.

### Image and playback decisions

The explicit request command opens or reuses shared human-only requests:

```bash
node --import ./scripts/ts-loader.mjs scripts/check_video_production_evidence.ts \
  --mission <ID> --request-approval prototypes
node --import ./scripts/ts-loader.mjs scripts/check_video_production_evidence.ts \
  --mission <ID> --request-approval playback
```

These commands write prototype-approval-requests.json and
playback-approval-request.json under evidence/. They do not write the task's
operator-owned acceptance deliverables. Inspect the requests on the shared
approval surfaces and have a server-identified human decide after reviewing the
images or playing the full render with sound. The task owner then records the
returned scene/request references in prototype-acceptance.json or
video-playback-approval.json and runs record-evidence. A local approved boolean
does not substitute for the approval-store record.

A prototype decision binds scene ID, source artifact bytes/path, revision, and
visual intent. Re-request only changed, expired, or revoked decisions; still-valid
decisions for unaffected scenes remain usable. Playback acceptance binds the exact
composed final-video.mp4 and evaluation report. It is a creative acceptance
decision and does not authorize publication.

For text_only and none scenes, prototype manifests/acceptance contain empty
arrays and no image request is opened. Text-only generated footage still requires
the final listening/playback decision. When all scenes use none, the owner records
not_required=true for playback; the existing independent evaluation still applies.

### Repair limits and enforcement boundary

max_repair_rounds is at most three. A generated scene's max_attempts includes its
initial generation and is at most 1 + max_repair_rounds (therefore at most four).
For a repair, remaining attempts and the cost of the flagged scenes' next pass
must fit the remaining cap. If the evaluation already passes, repair is a
pass-through and no new generation allowance is needed.

Before each new submission inside a generation/repair task, run the relevant
generation or repair checker again and update the cumulative asset manifest and
evaluation after collection. Fix only flagged scenes and preserve unaffected
selections. Changed take bytes or scene planning invalidate dependent evaluation.

These are mission phase preflight and evidence checks. They do not provide an
atomic provider billing reservation or prevent an unrelated ad-hoc provider call.
Price quotes and consumption must come from the current provider/job evidence;
technical stream/mux validation and independent quality review remain necessary.
