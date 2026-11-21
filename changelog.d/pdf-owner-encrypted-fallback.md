---
category: Fixed
---

- **Owner-encrypted PDF reading and password fail-closed handling** — `kyberion read` / `document-reader` now extracts decrypted text and title from owner/permissions-locked PDFs (no open password) via `pdf.js` fallback with an explicit warning, renders empty-text fallback pages when `--images` / `--ocr` is passed, and fails closed with an actionable error on user-password-protected PDFs.
