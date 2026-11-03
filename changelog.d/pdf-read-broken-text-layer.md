---
category: Changed
---

- `kyberion read` no longer turns PDF pages with an unmapped-font text layer into tables of control characters: broken positioned text is dropped and the clean pdf-parse text is used. Pages that still have no readable text (broken glyphs, or vector-only drawings) are drawn with pdf.js (`pdf-parse` `getScreenshot`, no `pdftoppm`/LibreOffice needed) — `--images <dir>` saves the page image for `kyberion see`, `--ocr` also OCRs it.
