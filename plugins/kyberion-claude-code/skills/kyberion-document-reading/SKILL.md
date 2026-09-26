---
name: kyberion-document-reading
description: Read a PDF, PowerPoint (.pptx), Word (.docx) or Excel (.xlsx) file in the Kyberion repo through the actuator (`pnpm kyberion read`) instead of writing unzip / pdftotext / python scripts. Use whenever the user asks to read, summarize, check, or extract data from such a file, or to ingest it into a tenant.
status: implemented
category: Orchestration
tags:
  - kyberion
  - claude-code
  - documents
  - pdf
  - pptx
  - docx
  - xlsx
  - ocr
---

# Reading documents in Kyberion

Never hand-roll a parser. The shell policy denies `unzip` / `pdftotext` /
`pdftoppm` / python-docx / openpyxl / python-pptx / pypdf on office and PDF
files (`document-hand-extraction`).

1. **Stage the file inside the repo** (inputs outside it are refused):
   `mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<file> active/shared/tmp/<job>/`
   Keep the original file name — it becomes the title when the document has no heading.
2. **Read it**: `pnpm kyberion read active/shared/tmp/<job>/<file>`
   - `--ocr` when figures, tables or whole slides are pasted images (local OCR only).
   - `--json` for `{format, title, tables, warnings, images, markdown}`; `--out <file>` to save.
   - `--images <dir>` writes every figure (slide / page / picture) as an image file — EMF/WMF converted to PNG — so you can look at charts and pasted tables directly.
   - Act on the `> [read] …` warnings (e.g. re-run with `--ocr`).
3. **Land it as tenant knowledge** (only when asked): ask which tenant, then
   `pnpm ingest --tenant <slug> --file <file> [--ocr] --dry-run --propose-tier`, review, and re-run without `--dry-run`.
4. **Check figures**: OCR scrambles label ↔ value pairing in financial tables — export them with `--images`, look at the image and transcribe such tables instead of trusting OCR.
5. Remove the staging directory when done.

Password-protected Office files (`CDFV2 Encrypted`) cannot be read — ask for a decrypted copy.
Full guidance: `knowledge/product/orchestration/document-file-reading-playbook.md`.
