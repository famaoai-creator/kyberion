---
category: Changed
---

- **Native PDF engine** — reader now walks classic `xref` / `startxref` / `/Prev` (and hybrid `/XRefStm`), honours xref-stream `/Index`, slices streams by `/Length`, and decodes ASCIIHex / ASCII85 / RunLength / Flate / LZW (+ PNG/TIFF predictors). Distills `/Outlines`, page `/Annots`, `/AcroForm` fields, and Form XObject `Do` text into the design protocol (markdown TOC / links / form table). Writer escapes literal control chars and embeds PNG alpha as `/SMask`. Portable pieces aligned with [PdfCraft](https://github.com/storytold/pdfcraft) (`pdfcraft-cos` / `pdfcraft-filters` / `pdfcraft-create`, MIT OR Apache-2.0).
