---
title: PDF CID Font Unicode Fallback (ROS→UCS2 CMap Resolution)
category: Architecture
tags: [architecture, pdf, native-pdf-engine, cid, tounicode, cjk, text-extraction, document-reader]
knowledge_type: explicit
intelligence_layer: methodology
importance: 7
author: Devin
last_updated: 2026-10-31
---

# PDF CID Font Unicode Fallback

`libs/core/media/native-pdf-engine/parser.ts` decodes text in three layers,
cheapest/most-exact first:

1. **`/ToUnicode` CMap** — the font's own mapping (standard path).
2. **CID ROS fallback** — when a Type0 + Identity-H font has no `/ToUnicode`
   (typical of Quartz/macOS "Print → PDF" output: Word → PDF, Hiragino and
   other CJK fonts), the content-stream codes are already ROS CIDs. The parser
   reads the descendant CIDFont's `/CIDSystemInfo` `(/Registry)` and
   `(/Ordering)` and resolves a vendored Adobe CMap by name —
   `{Registry}-{Ordering}-UCS2` under
   `libs/core/media/native-pdf-engine/cmaps/` — producing deterministic,
   exact Unicode with no OCR.
3. **Page OCR** — when no vendored map exists (unvendored ROS, or text that is
   still unmappable), `document-reader.ts` detects the raw-byte mojibake
   (control-byte + Latin-1 density, `isUnmappableTextLayer`) and, with
   `--ocr`, rasterizes via `pdftoppm` (`rasterizePdfPages` in
   `visual-raster.ts`) and OCRs the rendered pages.

## Vendored maps

| File                | ROS          | Script              |
| ------------------- | ------------ | ------------------- |
| `Adobe-Japan1-UCS2` | Adobe-Japan1 | Japanese            |
| `Adobe-GB1-UCS2`    | Adobe-GB1    | Simplified Chinese  |
| `Adobe-CNS1-UCS2`   | Adobe-CNS1   | Traditional Chinese |
| `Adobe-Korea1-UCS2` | Adobe-Korea1 | Korean              |

Source: freedesktop `poppler-data` `cMap/` (Adobe's official CMaps, BSD-style
redistributable — keep the embedded copyright header).

## Extending to another ROS

1. Download `Adobe-<Ordering>-UCS2` from `poppler-data` (`cMap/Adobe-<Ordering>/`)
   into `libs/core/media/native-pdf-engine/cmaps/`. No code change is needed —
   resolution is by filename.
2. Both hex `<…> Tj` and literal `(…) Tj`/`TJ` strings decode through the same
   map (`decodeShowString` / `literalStringToHex`); `parseTextOperators` tracks
   `Tf` state so per-font maps apply.
3. `parseToUnicodeCMap` handles `bfchar`, scalar `bfrange`, and the array form
   `<start> <end> [<u1> …]` used by the official CMaps.

## Caveats

- `CIDFontType2` (TrueType descendants) would need `cmap`/`post` tables —
  currently unhandled; those documents fall through to page OCR.
- Vertical writing (`Identity-V`) CIDs resolve through the same UCS2 map; only
  glyph orientation differs.
- The OCR layer stays the backstop: an unmappable layer with no vendored ROS
  warns `--ocr` users get page-level recovery marked "unverified".
