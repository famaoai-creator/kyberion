---
category: Fixed
---

- **`kyberion read` Office titles** — docx / pptx / xlsx now take File → Properties (`dc:title`) when present, fall back to heading / first slide / none, and ignore writer placeholders. Native Office writers no longer stamp fake `Kyberion Native *` titles; the PDF Info reader also recovers Subject / Creator / Keywords with the same literal decoding as Title.
