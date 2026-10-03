---
title: Capability Verb Inventory (which capabilities have one verb, which do not)
category: Orchestration
tags:
  [
    orchestration,
    perception,
    action,
    memory,
    cli,
    verbs,
    inventory,
    document-generation,
    media,
    working-memory,
  ]
importance: 7
author: Ecosystem Architect
last_updated: 2026-10-01
role_affinity: [ecosystem_architect, knowledge_steward, mission_controller, operator]
phase_affinity: [alignment]
---

# Capability Verb Inventory

The [perception playbook](./perception-playbook.md) gives one command per sense and
the [action playbook](./action-playbook.md) splits acting by target. This inventory is
the layer above both: it records **which capabilities are already reachable through a
single verb, which are only reachable through ops or pipelines, and which do not exist
at all** — so that the next capability is organized deliberately instead of
accumulating a second way to do something that already has one.
Japanese: [capability-verb-inventory.ja.md](./capability-verb-inventory.ja.md).

## 1. When a capability deserves a single verb

A one-word verb is justified only when **a unifying op already exists** that hides the
format or device behind one contract. `read` is the model: `media:document_digest`
absorbs `pdf_extract` / `pptx_extract` / `docx_extract` / `xlsx_extract`, so the CLI
needs one verb instead of five.

Where no unifier exists and the approval gates genuinely differ, the capability stays
**split by target** — that is why acting has `browser-actuator` / `system-actuator` /
`terminal-actuator` rather than a single `do`. Adding a verb without a unifier just
moves the branching into the CLI.

## 2. Taking in ↔ putting out

| Direction           | Unifying op                             | Verb                                                                  | State                    |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| Document → text     | `media:document_digest`                 | `pnpm kyberion read`                                                  | unified                  |
| Brief → document    | `media:generate_document`               | `pnpm kyberion write`                                                 | unified                  |
| Document ↔ document | `media:*_extract` design distillers     | `pnpm kyberion diff`                                                  | unified                  |
| Image → text        | `vision:ocr_image` / `describe_image`   | `pnpm kyberion see`                                                   | unified                  |
| Prompt → image      | `media-generation:generate_image`       | `pnpm kyberion draw`                                                  | unified                  |
| Audio → text        | `voice:transcribe`                      | `pnpm kyberion listen`                                                | unified                  |
| Text → audio        | `voice:generate_voice` / `speak_local`  | `pnpm kyberion speak`; `--stream --segment` streams local Qwen speech | unified                  |
| Video → timeline    | frames + transcript composition         | `pnpm kyberion watch`                                                 | unified                  |
| Brief → video       | `video-composition:*`, `generate_video` | —                                                                     | **no verb, two engines** |

`write` is the worked example of §1. `media:generate_document` already dispatched on
`render_target` (pptx / docx / xlsx / pdf) and the per-format `pptx_render` /
`docx_render` / `xlsx_render` / `pdf_render` ops were already compatibility adapters —
`warnLegacyMediaOp` points callers at
`document_outline_from_brief → brief_to_design_protocol → generate_document`. Because
that unifier existed, the verb is a thin entry over it and adds no branching of its
own: `pnpm kyberion write <brief.json> --out <file>` takes the render target from
`--to`, else the brief's `render_target`, else the `--out` extension, and lets the
design cascade supply theme and layout. Per-artifact guidance still lives in
[presentation-authoring-playbook](./presentation-authoring-playbook.md),
[blog-authoring-playbook](./blog-authoring-playbook.md) and
[narrated-video-production-playbook](./narrated-video-production-playbook.md).

`diff` hides the format behind the `media:*_extract` distillers the same way
`read` hides it behind `document_digest`: both files go through the same
native extractor (docx/pptx/xlsx/pdf) and the designs are compared field-by-field,
with volatile keys (`generatedAt`, extracted image paths) ignored. It is the
verification half of a reproduction run — extract → render via the
`media-docx-roundtrip` template, then `pnpm kyberion diff <source> <output>`.

`draw` is the inverse of `see`. The unifier is the image-generation bridge
(`generateImage` / `planImageGeneration` in `libs/core/media/image-generation-bridge.ts`),
which already hides the provider behind one router. What kept the row empty was the
egress decision, so the verb owns exactly that and nothing else: by default only
providers that keep the data on this machine and finish unattended are eligible;
`--allow-cloud` adds cloud providers and `--allow-handoff` adds host-agent hand-off as
a last resort (exit 100; the rerun collects the image only if the host saved it for
that request — `libs/core/host-image-handoff.ts` — never a file that was already there). The gate is an explicit provider allowlist
(`ImageGenerationRequest.allowedProviders`) that the router enforces on every selection
path — `mode: 'local_only'` alone is not enough, because host bridges run locally but
forward the request to the host agent's model. Reference images (`--ref`) follow PA-10:
a cloud or hand-off provider needs a per-run consent naming it, and `--dry-run` shows
which provider that would be before anything is sent.

The video row is still **not** ready for the same treatment: it has two engines
(`video-composition:*` for narrated composition, `generate_video` for model generation)
with no unifier to hide the choice.

## 3. Inputs that are not files

The sense verbs all take a path inside the repository. The two most common real-world
inputs are therefore not reachable by a verb:

| Input              | Today                                                                                                        | Why it is not a verb yet                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| URL / web page     | `network:fetch` (egress-governed) → save → `read` the saved file                                             | `read` refuses URLs by design (`document-reader.ts`); folding fetch into it would move an egress decision under a perception verb |
| The current screen | `media-generation:capture_screen` / `capture_focused_window`, `system:list_displays`, `system:record_screen` | capture applies screen-frame redaction and lives on the action side; `see` only reads files                                       |

Resolved 2026-09-27 (MSN-CAPTURE-RECORD-20260927): capture is now two verbs —
`pnpm kyberion capture [--screen|--window|--camera]` (still, via
`system:screenshot` / `system:capture_photo`) and
`pnpm kyberion record screen|audio|camera` (time-series, via
`system:record_screen` / `system:record_audio` / `system:record_camera`).
The redaction gate stays in the actuator; the verbs own only arg parsing and
repo-boundary checks. `see` remains file-only by design. Not folded: `read
<url>` (egress gate still open), explicit `browser:record` (needs session
lifecycle — deferred by design), mobile video (no device bridge).

Both are two-step today, and both are cheap to fold into one verb (`read <url>`,
`see --screen`) — the open question is where the egress and redaction gate is
evaluated, not whether the engine exists.

## 4. Batch, streaming playback, and live dialogue

`speak` now covers two playback modes, while `voice conversation-turn` is a complete dialogue workflow:

| Word     | File / batch meaning                                       | Streaming playback                                                                                 | Live dialogue                                                                      |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `listen` | `pnpm kyberion listen <audio>` (transcribe a recording)    | —                                                                                                  | `meeting:listen` (capture ops), `pnpm minutes:record` (live mic)                   |
| `speak`  | `pnpm kyberion speak "<text>"` (TTS, optionally to a file) | `pnpm kyberion speak --stream --engine qwen3_tts_06b_custom_voice --segment "..." --segment "..."` | `meeting:speak`; `pnpm kyberion voice conversation-turn` (full real-time dialogue) |

Streaming playback sends multiple text segments to the local Qwen engine and plays generated audio as it arrives. It does not capture a microphone or manage a back-and-forth session. `voice conversation-turn` is the dialogue workflow. A recording and a live microphone session also have different failure modes and consent requirements (`meeting:check_consent`); label the mode explicitly wherever both appear.

## 5. The third axis: memory

Perception and action are organized; remembering is not. Its entry points are spread
across three unrelated surfaces:

| Need                        | Entry point                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Note / recall working state | `working-memory` domain (`note`, `read`, `list`, `daily-open`, `weekly-open`, `todo-*`, `nominate-promotion`) |
| Search stored knowledge     | `wisdom:knowledge_search` / `knowledge_read` / `knowledge_inject`, `pnpm knowledge`                           |
| Search past sessions        | `wisdom:history_search`, `pnpm history:search`                                                                |
| Land knowledge for a tenant | `pnpm knowledge:ingest --tenant <slug> --file <file>`                                                         |

There is no playbook covering this axis and no verb for "remember" or "recall", so the
same lookup is re-improvised per mission. This is the largest unorganized area — and
unlike §2 and §3 it needs a concept decision first (what belongs in working memory
versus `knowledge/`), not just a CLI entry.

## 6. Diagnose and set up — one verb each, narrowed by scope

Diagnostics and setup grew one command per area. They now have one entry each,
and the area is a scope that delegates to the existing implementation (the old
commands keep working):

| Verb                                 | Scope / area → existing command                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm kyberion doctor [--scope <s>]` | none → health rollup (unchanged); `env` → `vital`; `service` → `service preflight`; `voice` → `doctor --runtime voice`; `meeting` → `meeting preflight`; `app` → `doctor --runtime app`; `setup` → `setup report`                                                                                       |
| `pnpm kyberion setup <area>`         | `onboarding` → `onboarding`; `context` → `onboarding context`; `reasoning` → `reasoning setup`; `env` → `env bootstrap`; `services` → `service setup`; `tools` → `tool setup`; `provider-cli` → `provider-cli setup`; `agy-sdk` → `agy sdk-setup`; `voice` → `voice setup`; `config` → `config-mission` |

The mapping lives in `knowledge/product/governance/cli-commands.json` (`scopes` on the
`doctor` and `setup` commands); `kyberion --help` and a bare `kyberion setup` render it.

## 7. Known non-existent capabilities

Record these so they are not re-investigated:

- **Music / non-speech audio analysis** — generation only (`generate_music`); no
  analysis engine. Already noted in the perception playbook.
- **Physical movement** — no robotics or GPS layer; "move" is a focus change inside a
  hands executor. Already noted in the action playbook.
