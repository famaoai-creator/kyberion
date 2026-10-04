---
title: Timeline Video Authoring Playbook
kind: playbook
scope: repository
authority: reference
phase: [alignment, execution, review]
role_affinity: [media_producer, ecosystem_architect]
tags: [video, narrated, timeline-html, hyperframes, scratch-first, design]
owner: ecosystem_architect
last_updated: 2026-10-04
---

# Timeline Video Authoring Playbook

How to make a narrated promo / explainer that people want to watch, using
`video-composition:create_timeline_video` (authored `timeline-html` scenes,
narration-timed, rendered by HyperFrames). It distills the 2026-10 Kyberion
self-intro rebuild: the same narration and renderer went from "static slides"
to a watchable film because of scene design and timing, not a new backend.

Parent: [`narrated-video-production-playbook.md`](./narrated-video-production-playbook.md)
(scratch first, promote after acceptance).

## When to use which path

| Need                                                                 | Path                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Designed promo, product film, launch clip — the look matters         | `create_timeline_video` with authored scenes (this playbook)                             |
| Repeatable template output from a brief (reports, how-tos at volume) | `create_narrated_video_from_content_brief` / `create_narrated_intro_movie`               |
| Prompt-led generative footage                                        | [`generate-video-from-adf.md`](../../public/procedures/media/generate-video-from-adf.md) |

## The rules that made the difference

1. **Narration first, per scene.** Write one narration line per scene, render
   each line to its own clip (voice-actuator), and let the measured clip length
   size the scene (`planNarrationTimeline`: lead 0.6s + narration + hold 0.9s).
   Never split a single long voice track by fixed percentages: cues drift off
   the words.
2. **Cue every reveal to the voice.** Use `--f` (fraction of the scene's
   narration) instead of absolute seconds so re-recording the voice keeps the
   sync. Reveal across the whole scene; front-loading everything at t=0 reads
   as a slide.
3. **On-screen text is not the narration.** Show the hero word, the number, the
   short claim. Full sentences on screen double-print what the voice says and
   force truncation.
4. **Use real material.** Counts from the repo (actuators, backends), real
   surface screenshots (`docs/assets/surfaces/`), the real wordmark and brand
   tokens (`knowledge/public/design-patterns/brand-tokens/kyberion.json`).
   Invented filler is what makes a video look generic.
5. **Japanese typography.** Scenes get `word-break: auto-phrase`, strict line
   breaking and balanced headings automatically (`data-kb-typography`). Do not
   use negative letter-spacing on Japanese headlines. Don't truncate with
   `…`; shorten the copy.
6. **Check frames before delivering.** Pull a contact sheet
   (`ffmpeg -vf "fps=1/5,scale=480:-1,tile=4x3"`) and look at it. Every bug in
   the rebuild (an overlapped badge, a blank CTA, a late cue) was visible on
   the contact sheet and invisible in the logs.

## Authoring a `timeline-html` scene

Each scene supplies `html` (body markup) and optional `css`. The runtime
(`libs/core/video/video-timeline-runtime.ts`) makes the scene seekable for
HyperFrames, and provides these cues. Times are seconds from scene start, plus
`f ×` that scene's narration length:

| Cue               | Markup                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| Entrance          | `class="kb-cue kb-rise" style="--at:.4; --f:.3"`                                        |
| Variants          | `kb-fade`, `kb-scale`, `kb-pop`, `kb-left`, `kb-right`, `kb-focus`, `kb-wipe`, `kb-out` |
| Duration override | `style="--du:1.2s"`                                                                     |
| Typewriter        | `<span data-type="今週の進捗レポートを作って" data-f=".1" data-cps="9">`                |
| Count-up          | `<div data-count="37" data-f=".2" data-dur="1.5">0</div>`                               |
| Caret blink       | `<i data-blink>▍</i>`                                                                   |
| Continuous motion | CSS using `var(--kb-t)` (seconds) or `var(--kb-p)` (0–1 scene progress)                 |
| Assets            | declare `asset_refs`, reference as `src="{{asset:<asset_id>}}"`                         |

Pitfalls the runtime already handles, and why:

- **Seek, don't play.** HyperFrames captures by seeking. Scenes run in iframes,
  so the top-level HyperFrames runtime cannot reach their CSS animations. Each
  scene sets `animation.currentTime` itself. The old template stub only logged,
  which is why template motion never appeared in renders.
- **Cue variables must not inherit.** `--at`, `--f` and `--du` are registered with
  `@property … inherits: false`. As plain custom properties, a child without
  its own `--f` inherited its wrapper's cue and appeared seconds late.
- **Exit vs. entrance on one element.** Put `kb-out` on a wrapper and the
  entrance on the child. Two animations on one element fight over `fill-mode`.

## Example call

```json
{
  "action": "create_timeline_video",
  "params": {
    "title": "Kyberion intro",
    "scenes": [
      {
        "scene_id": "hook",
        "role": "hook",
        "html": "<h1 class=\"kb-cue kb-rise\" style=\"--at:.4\">曖昧な依頼を、成果まで。</h1>",
        "css": "h1 { font-size: 96px; font-weight: 900; }",
        "narration_ref": "active/shared/tmp/<job>/vo/hook.wav"
      },
      {
        "scene_id": "outro",
        "role": "outro",
        "html": "<div class=\"kb-cue kb-scale\" style=\"--f:.8\">KYBERION</div>",
        "narration_ref": "active/shared/tmp/<job>/vo/outro.wav",
        "min_sec": 6
      }
    ],
    "output": { "format": "mp4", "target_path": "active/shared/tmp/<job>/intro.mp4" }
  }
}
```

The op probes each clip, plans the timeline, mixes the clips onto one
narration track (`active/shared/tmp/video-composition/timeline-narration/`),
and renders through the governed backend (`hyperframes_cli`).

## Voice notes

- macOS: `local_say`. On Linux, `espeak_ng` reads kanji as "Chinese letter".
  Narrate a kana reading there, or use a neural engine (`kokoro`, which needs
  the Kokoro-82M weights reachable from `huggingface.co`).
- Keep each scene's line to one or two short sentences. That is 3–10s of
  narration per scene and 80–100s for a 10-scene film.
