---
title: Japanese Voiceover + HyperFrames Video Production Playbook
kind: playbook
scope: repository
authority: reference
phase: [execution, review]
tags: [video, narrated, tts, kokoro, mlx, japanese, hyperframes, subtitles, qa]
owner: ecosystem_architect
last_updated: 2026-10-13
---

# Japanese Voiceover + HyperFrames Video Production Playbook

End-to-end procedure for a narrated explainer clip in Japanese, built from local
assets: script → voiceover → subtitle timing → composition → check → preview →
render. Distilled from the MSN-MEDIA-PIPELINE-20261013 run, where skipping the
gates below produced a wrong-reading, flat, mis-timed first cut.

Parent: [`narrated-video-production-playbook.md`](./narrated-video-production-playbook.md) · Promotion rule: [`scratch-to-pipeline-video-promotion.md`](./scratch-to-pipeline-video-promotion.md)

## 0. Provider preflight — do not default to local Kokoro silently

Voice provider order (media-use skill): **HeyGen Starfish** (free-usage path,
returns word timestamps) → **ElevenLabs** → **local Kokoro-82M** (always
available fallback). The Japanese Kokoro voices are graded **C−/C/C+** in the
upstream VOICES.md — the weakest tier. For a deliverable anyone else will hear,
run `npx hyperframes auth status` and offer the user the sign-in choice first;
for scratch or local iteration Kokoro is acceptable.

## 1. Script: write the reading, not just the text

`mlx_audio`'s Kokoro pipeline instantiates `misaki.ja.JAG2P` with the default
`version='cutlet'` (1st-gen tokenizer). Consequences measured on
`mlx-community/Kokoro-82M-4bit`:

| cutlet behavior                                  | Symptom                            | Rule                                                                                          |
| ------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Latin alphabet strings pass through unphonemized | `AI` is read あい, not エーアイ    | Write acronyms/loanwords in katakana: `エーアイ`, `エルエルエム`, `エムエルエックス`          |
| Number + counter compounds misread               | `第3位` → だいさんくらい           | Write rankings/counters in kana: `だいさんい`, `だいにい`, `だいいちい`, `みっつ`             |
| No pitch-accent marks emitted at all             | Flat intonation regardless of text | Compensate with punctuation (！、) and per-line synthesis; accept the voice's natural cadence |

> Do **not** switch `JAG2P` to `version='pyopenjtalk'` (2nd-gen, pitch-accent
> marks). With `Kokoro-82M-4bit` it produces _worse_ audio — phoneme inventory
> mismatch: garbled words (サイバーセキュリティ→セオリティ), pitch drop
> (~160 Hz vs ~240 Hz), and a vocalized artifact after each utterance. Verified
> 2026-10-13; do not retry on the same model.

### Pronunciation lint before synthesis

Dump the predicted phonemes first — misreads are cheaper to fix in text than in
audio:

```bash
<VENV_PYTHON> - <<'EOF'
from misaki.ja import JAG2P
g = JAG2P(version='cutlet')
for line in open('script.txt'):
    line = line.strip()
    if line:
        print(g(line)[0])
EOF
```

Any alphabet fragment left unphonemized in the output is a future misreading.

## 2. Synthesize per line, then join

One file per script line gives controllable inter-line pauses and cheap re-takes:

```bash
HF_HUB_CACHE=<cache> <VENV_PYTHON> -m mlx_audio.tts.generate \
  --model mlx-community/Kokoro-82M-4bit \
  --text "$(cat script.txt)" \
  --voice jf_gongitsune --lang_code j --speed 1.15 \
  --output_path <work> --file_prefix narr --audio_format wav
```

- Japanese voices present in the 4bit pack: `jf_alpha` (flat, reference),
  `jf_gongitsune` (characterful, fits mascot content), `jf_nezumi`,
  `jf_tebukuro`, `jm_kumo` (male, most F0 movement measured: dyn ~165 Hz).
- Join with trailing-silence trim + ~0.25 s gaps (`wave` + `numpy`).

The **governed route** is the `voice:generate_voice` op with
`engine.engine_id: "kokoro"` and `params.voice: "jf_gongitsune"` (passthrough
to `kokoro_tts_bridge.py`, which maps ja → the `j` pipeline and defaults to
`jf_alpha` when `voice` is omitted) — the template below uses it. The direct
`mlx_audio.tts.generate` CLI is acceptable for scratch iteration only; both
paths share the same misaki cutlet default, so the reading rules in §1 apply
identically.

## 3. Verify by round-trip transcription

Re-transcribe the joined wav and compare against the script's _intended_
readings — this is the gate that caught nothing in the first cut:

```bash
<VENV_PYTHON> -c "
import mlx_whisper
r = mlx_whisper.transcribe('narr.wav',
    path_or_hf_repo='mlx-community/whisper-large-v3-turbo',
    language='ja', verbose=False)
for s in r['segments']:
    print(f\"[{s['start']:.2f}-{s['end']:.2f}] {s['text']}\")"
```

Alphabet tokens coming back as Latin (`AI`) means エーアイ was spoken; a kana
rendering (`アイ`) or a different word means re-write and re-synthesize. Keep
the segment times — they are the subtitle timings.

## 4. Sync subtitles and duration to the audio

- `data-start`/`data-duration` of each subtitle clip = whisper segment bounds.
- Root `data-duration` = audio length + ~0.3 s tail; `<audio>` `data-duration` =
  actual audio length.
- Re-time GSAP beats that referenced the old narration (kicker pops, highlight
  pulses) to just before each segment start; extend loop `repeat` counts to the
  new duration.

## 5. Visual assets — two failure modes seen in production

- **Generated images carry a baked background**: mflux output is 1024×1024 RGB
  (no alpha). Run `npx hyperframes remove-background in.png -o out.png` (CoreML,
  ~0.4 s/image) and reference the RGBA output. A white subject on a light scene
  needs a contrast backdrop (soft halo disc), not only a drop-shadow.
- **Font subsets must cover every used glyph**: a subset file with only
  glyphs for its sample string silently falls back to the system CJK font
  (`fontTools` check: `f['maxp'].numGlyphs`). Extract the exact text set used in
  the composition and subset from a full system font —
  `python3 -m fontTools.subset "/System/Library/Fonts/ヒラギノ角ゴシック W9.ttc" --font-number=0 --text-file=chars.txt --output-file=jp-w9-subset.otf --no-hinting --desubroutinize`
  (~37 KB for ~160 chars). Yu Gothic is not bundled on macOS; Hiragino W9 is
  the close substitute.

## 6. Gates — never render on the first green check

1. `npx hyperframes check` — must pass with 0 errors (fix `content_overlap`
   layout errors; `nested_structure_needs_subcomposition` warnings are
   acceptable for single-scene clips).
2. `npx hyperframes preview --background` — human watches; approval required
   before render.
3. `npx hyperframes render --quality looks --output out.mp4` — for unattended
   runs use `HYPERFRAMES_RENDER_DETACHED=1` in its own process group.
4. Verify: `ffprobe -v error -show_format -show_streams` — duration matches
   `data-duration`, audio stream present.

## 7. When the renderer crashes

`chrome-headless-shell` SIGSEGV during `check`/`render` on this machine was
caused by host memory/CPU pressure, not the composition — it passed cleanly once
load dropped. Before retrying: `npx hyperframes doctor --json`, check
`vm_stat`/load, and fix the environment. Never blind-retry a crashing tool;
the first failure run cost 15 retries in a row.

## References

- Voice/backend registry: [`../governance/media-backends/`](../governance/media-backends/index.json)
- TTS provider routing and HeyGen word timestamps: media-use skill, `audio/references/tts.md`
- Local model findings: `../architecture/local-voice-engine-findings.md`
