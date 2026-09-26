---
title: Perception Playbook (read / see / listen / watch — one entry per sense)
category: Orchestration
tags:
  [
    orchestration,
    perception,
    ocr,
    stt,
    video,
    image,
    audio,
    html,
    markdown,
    vision-actuator,
    voice-actuator,
  ]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-25
role_affinity: [ecosystem_architect, knowledge_steward, researcher, analyst, mission_controller]
phase_affinity: [alignment, execution]
---

# Perception Playbook

When an agent has to **take something in** (a document, a web page, a screenshot,
a recording, a video), there is one command per sense. Each one reads a file inside
the repository, prints Markdown on stdout (`--json` for structure, `--out` to write
a file), keeps logs off stdout, and runs **local-only** by default (no data egress).
Japanese: [perception-playbook.ja.md](./perception-playbook.ja.md).

## 1. The four senses

| Sense      | Command                                                        | Inputs                                               | Engine (shared with the pipeline op)                                                          |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 文章を読む | `pnpm kyberion read <file> [--ocr]`                            | pdf, pptx, docx, xlsx/xlsm, html/htm, md, txt        | `@agent/core/document-reader` = `media:document_digest`                                       |
| 画像を見る | `pnpm kyberion see <image> [--describe]`                       | png, jpg, webp, gif, heic, tiff, bmp                 | `@agent/core/ocr-bridge` (local) = `vision:ocr_image`; `--describe` = `vision:describe_image` |
| 話を聞く   | `pnpm kyberion listen <audio> [--timestamps]`                  | wav, mp3, m4a, aac, flac, ogg, opus, webm, caf, aiff | speech-to-text seam (`@agent/core/speech-to-text-bridge`) = `voice:transcribe`                |
| 動画を見る | `pnpm kyberion watch <video> [--every <sec>] [--frames <dir>]` | mp4, mov, m4v, webm, mkv, avi                        | ffprobe/ffmpeg → frames through `see`'s OCR + audio through `listen`                          |

`watch` is a composition, not a new engine: frames are OCR'd like `see` and the audio
track is transcribed like `listen`, then merged into a timeline (`## Transcript`,
`## Frames` with `### mm:ss` headings; near-duplicate frames are dropped). Use
`--frames <dir>` to keep the sampled PNGs and look at them directly when OCR is not
enough (charts, diagrams, faces).

Detailed document rules (engines per format, ingest, OCR traps):
[document-file-reading-playbook.md](./document-file-reading-playbook.md).

## 2. Decide the goal first

| Goal                                 | Use                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Understand it now, nothing persisted | the sense command above                                                                      |
| Same inside a pipeline               | `media:document_digest`, `vision:ocr_image`, `voice:transcribe`                              |
| Meeting minutes (speaker, actions)   | `pnpm minutes:record` (live mic) / `ingest:meeting_digest` — see meeting-operations-playbook |
| Land it as tenant knowledge          | `pnpm ingest --tenant <slug> --file <file> [--ocr]` (documents, html, md)                    |
| Web page (URL)                       | `network:fetch` (egress-governed) to save it, then `read` the saved file                     |

## 3. How to run

```bash
mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<file> active/shared/tmp/<job>/
pnpm kyberion see    active/shared/tmp/<job>/screenshot.png --lang ja
pnpm kyberion listen active/shared/tmp/<job>/call.m4a --timestamps
pnpm kyberion watch  active/shared/tmp/<job>/demo.mp4 --every 5 --frames active/shared/tmp/<job>/frames
pnpm kyberion read   active/shared/tmp/<job>/page.html
```

Warnings are printed as `> [<command>] …` lines after the content — act on them
(e.g. no transcript, frames skipped) rather than treating silence as "nothing there".

## 4. Traps

1. **Input must be inside the repository.** Copy into a uniquely named
   `active/shared/tmp/<job>/` first; remove it when done.
2. **`listen` needs a real speech-to-text backend.** It refuses the stub and
   synthetic results (exit 1) instead of printing fake text. Set one up with
   `pnpm kyberion voice setup`; on macOS the Apple Speech backend also needs the
   Speech Recognition permission (`speech_permission_0` means it was not granted).
   In `watch`, a missing transcript is only a warning.
3. **`--describe` may leave the machine.** OCR is local; image description goes to
   whatever description provider resolves (none on macOS today — you get a warning).
   Do not use it on confidential images unless the provider is local.
4. **Frame times in `watch` are sampling positions**, not decoded timestamps; with
   `--every N` expect roughly `duration / N` frames. Use a smaller `--every` for
   slides that change quickly.
5. **OCR loses table structure** (see document playbook trap 3). For tables and
   charts in images or frames, look at the image (`--frames`) and transcribe it.
6. **Do not hand-roll perception.** `tesseract`, `whisper` / `mlx_whisper`,
   `ffmpeg … %04d.png` frame dumps and pytesseract / cv2 / whisper scripts are denied
   by the shell policy (`media-hand-perception`) and point back here. Ordinary
   ffmpeg production work (encoding, composition) is not affected.

## 5. Not covered (yet)

- **URLs** — `read` refuses them on purpose; remote content goes through the
  egress-governed `network:fetch` op.
- **Music / non-speech audio** — no analysis engine exists (only music generation).
- **Action side** (converse, hands, move) — see
  [action-playbook.md](./action-playbook.md).
- **URLs, the live screen, authoring (the inverse of `read`) and the memory axis** —
  which of those have a verb and which do not is tracked in
  [capability-verb-inventory.md](./capability-verb-inventory.md).
