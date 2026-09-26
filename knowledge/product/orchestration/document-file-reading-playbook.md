---
title: Document File Reading Playbook (PDF / PPTX / XLSX / DOCX → text, tables, OCR)
category: Orchestration
tags: [orchestration, media-actuator, ingest-actuator, pdf, pptx, xlsx, docx, ocr, ingest]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-25
role_affinity: [ecosystem_architect, knowledge_steward, researcher, analyst, mission_controller]
phase_affinity: [alignment, execution]
---

# Document File Reading Playbook

Which engine to use when an agent has to **read** an office document or PDF — to
answer a question, summarize it, or land it in `knowledge/` — and the traps that
cost time when the wrong rung is picked. `read` also takes `.html` / `.htm` / `.md` /
`.txt` (URLs are refused — save them with `network:fetch` first); images, audio and
video have their own commands (`see` / `listen` / `watch`) — see
[perception-playbook.md](./perception-playbook.md). Japanese: [document-file-reading-playbook.ja.md](./document-file-reading-playbook.ja.md).

## 1. Decide the goal first

| Goal                                                               | Use                                                                                                            | Output                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Read / answer / summarize now (nothing persisted)                  | `pnpm kyberion read <file> [--ocr]`                                                                            | Markdown on stdout (`--json` for format, title, tables, warnings) |
| Same inside a pipeline                                             | `media:document_digest { path, ocr? }`                                                                         | Markdown in context                                               |
| Structured data for further ops (layout, images, per-slide fields) | `media:pdf_extract`, `media:pptx_slide_text`, `media:pptx_extract`, `media:xlsx_extract`, `media:docx_extract` | design protocol / slide records in context                        |
| Land it as tenant knowledge (governed, ledgered)                   | `pnpm ingest --tenant <slug> --file <path> [--ocr]`                                                            | knowledge card + asset ledger record                              |

`kyberion read`, `document_digest` and the ingest ceremony share one reader
(`@agent/core/document-reader`), so a document reads the same everywhere.
Do not hand-roll `unzip` / `pdftotext` / python-docx / regex extraction — the
shell policy denies it (`document-hand-extraction`) and points back here — and
the ingest ceremony is the only sanctioned way into
`knowledge/confidential/{tenant}/`.

## 2. Engines by format

### PDF — native PDF engine (`libs/core/src/native-pdf-engine/`)

- `media:pdf_extract { path, ocr? }` → `PdfDesignProtocol`: per-page text (pdf-parse
  cleaner text merged in), positioned text elements, and **placed images extracted
  to PNG/JPEG** with their page position.
- `media:document_digest { path, ocr? }` → Markdown with page markers, heuristic
  tables and metadata.
- `ocr: true` (or `{ enabled, language, mode, min_area_ratio }`) OCRs the images on
  each page — pasted tables, charts, screenshots. Images under 3% of the page (logos)
  are skipped. Local providers only by default (`mode: 'local_only'`, Apple Vision /
  tesseract).
- Scanned PDFs (one full-page image per page): `media:pdf_to_pptx_design` with
  `hints.features.fullPageImageOcrOverlay: true`. This overlay does **not** fire for
  partial-page images; use `ocr: true` above for those.
- PDF → spreadsheet grid: `media:pdf_to_xlsx_design`.
- Page manipulation only (split/merge/rotate/encrypt…): the `pdf_*` pypdf ops — they
  do not read content.

### PPTX — native PPTX engine (`extractPptxSlides`)

- `media:pptx_slide_text { path, ocr? }` → one record per slide **in presentation
  order** (`position`; `slide_index` stays the `slideN.xml` file number), with
  `hidden`, `shapes_text` (paragraphs newline-separated), `tables` (rows of cells),
  `notes_text` (speaker notes), `image_parts`, `concatenated`.
- `ocr: true` OCRs slide images; EMF/WMF (what Office stores for pasted Excel
  ranges) are rasterized through LibreOffice first. Images that still cannot be read
  are listed in `ocr_skipped` — never read "no OCR text" as "no figure".
- `media:pptx_extract` → full design protocol (layout, theme, assets) when you need
  geometry, not just text.

### DOCX / XLSX — native readers (`libs/core/src/docx-utils.ts`, `xlsx-utils.ts`)

`native-docx-engine` / `native-xlsx-engine` are the _writers_; reading goes through
`distillDocxDesign` / `distillXlsxDesign` (JSZip-based, no mammoth/exceljs). Both
accept a path or raw bytes.

- `media:docx_extract { path, image_dir?, embed_images? }` → `DocxDesignProtocol`
  (body blocks, tables, numbering, styles, drawings). Pictures are written as files
  and referenced by `drawing.imagePath` — by default under
  `active/shared/tmp/native-docx/images/<doc-hash>/` (24h TTL), or `image_dir`.
  Pass `embed_images: true` for a self-contained design (inline base64 `imageData`,
  multi-MB for image-heavy documents) when the design must be rendered back after
  the tmp floor expires. The native writer accepts either form.
- `media:document_digest` (docx) → Markdown with headings, lists, line breaks
  (`<w:br/>`), **tables**, and `_[image: media/imageN.png]_` markers for pictures.
- `media:xlsx_extract { path, sheet?, range?, values_only? }` — pass a sheet/range
  or `values_only` for a slim values-only projection instead of the full styled
  design. Merged ranges keep their value in the top-left cell only.
- `media:document_digest` (xlsx) → one Markdown table per visible sheet; hidden
  rows/sheets are skipped, cell newlines become `<br>`, and numbers are
  rendered with the cell's number format (`33.5%`, `1,234,567`, `▲28,957`,
  `2026/05/31`) instead of the raw stored value.

### Ingest ceremony (`pnpm ingest`)

- Formats: `docx`, `pdf`, `xlsx`, `pptx`, `html`, `slack_thread`, `markdown`, `text`
  (inferred from the extension).
- `--ocr` (pptx, pdf, docx): OCR embedded images locally and add them to the card
  as `Image text (OCR — unverified)` blocks (docx: in place of each image marker).
  Use it for "slides pasted into Word" documents — their text is all in images.
- docx/xlsx go through the same native readers as `document_digest`; mammoth /
  exceljs are only a fallback when the native reader rejects a file.
- Always `--dry-run` first (add `--propose-tier` to see the tier proposal and PII
  findings). Keep `--source-id` stable per source so a re-ingest supersedes instead
  of forking.
- `--source-id` defaults to the file name, so the same document staged in a
  different tmp dir still maps to the same asset. Cards ingested earlier with an
  explicit id (e.g. `downloads/<name>`) keep it — pass the same id to supersede them.
- Without `--target` the dry run lists the tenant's existing folders; pick one
  instead of the default `ingest/`.
- `--reparse`: when the reader improves (new table / number-format / OCR handling),
  re-parse an already-ingested, unchanged source and supersede its card
  (version +1, `reparse` in the transform chain). Refused for any other duplicate.

## 3. How to run a one-off read

```bash
mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<file> active/shared/tmp/<job>/
pnpm kyberion read active/shared/tmp/<job>/<file>            # Markdown
pnpm kyberion read active/shared/tmp/<job>/<file> --ocr      # + text inside images
pnpm kyberion read active/shared/tmp/<job>/<file> --json --out active/shared/tmp/<job>/read.json
pnpm kyberion read active/shared/tmp/<job>/<file> --images active/shared/tmp/<job>/images  # figures as files
```

`read` skips the runtime bootstrap and keeps logs off stdout (about 1–2 s for a
small file; `--verbose` restores logs), so its output can be piped as-is.
Warnings (images not OCR’d, hidden sheets, unreadable pictures) are printed as
`> [read] …` lines after the Markdown — act on them (e.g. re-run with `--ocr`)
rather than assuming the document has no figures. In pipeline JSON use
`"op": "media:document_digest"`; there is no need to write a script or an ADF
file to read a document.

## 4. Traps (all hit in practice)

1. **Input must be inside the repository.** `~/Downloads/...` is refused. Copy the
   source into a uniquely named `active/shared/tmp/<job>/` directory first.
2. **Pick the final artifact.** Decks come as many drafts; a same-day `final.pdf`
   usually beats the newest `DraftN.pptx`. Check modification times and ask when
   unsure.
3. **OCR of tables loses label ↔ value pairing.** Apple Vision reads columns
   top-to-bottom, so balance sheets and P&Ls come out as a list of labels then a
   list of numbers. For financial tables, look at the image and transcribe it into a
   Markdown table; keep OCR for prose-heavy images (assessments, contracts).
   Use `--images <dir>` to get each figure as a PNG (EMF/WMF converted) and read it
   directly — no package extraction by hand.
4. **Chart images OCR badly.** Record only the data labels printed on the chart and
   say that unlabeled points must be read from the source.
5. **Identity for confidential writes.** `pnpm ingest` needs
   `KYBERION_PERSONA=ecosystem_architect MISSION_ROLE=mission_controller`. The
   ceremony now checks this up front and refuses — without a policy violation —
   with the exact command to run, so there is no reason to guess roles (three
   violations in ten minutes trip the kill switch).
6. **PII.** The ingest gate masks e-mail / phone / account / address and blocks card
   and My Number values. It does not detect personal names; OCR of contracts and
   PDF metadata (author) can carry them — review before committing.
7. **Clean up extracted images.** PDF images land in
   `active/shared/tmp/native-pdf/images/<doc-hash>/`, PPTX assets under
   `active/shared/tmp/actuators/media-actuator/`. Tenant figures should not sit there
   for the 24h TTL; remove the directories you created once the card is committed.
8. **Password-protected Office files** (`file` reports `CDFV2 Encrypted`) cannot be
   read — there is no decryption op. Ask the owner for a decrypted copy instead of
   retrying.
9. **Stage with the original file name.** When a document has no heading, its card
   title falls back to the file name — an ASCII rename like `incident.docx` becomes
   the title. Keep the original name (drop only copy suffixes such as ` (1)`).
10. **Record how the text was obtained.** State in the card which parts are engine
    text, OCR (unverified) or manual transcription, so readers know what to re-check.
