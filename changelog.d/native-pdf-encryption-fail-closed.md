---
category: Fixed
---

- Native PDF generation now rejects every explicit encryption request from render options or the document protocol before file I/O. Existing output files remain unchanged.
- The previous implementation emitted an encryption dictionary but did not encrypt document strings or streams. Its password-hashing and PDF revision claims were incorrect; the incomplete handler has been removed rather than presenting plaintext as password-protected output.
- Ordinary PDF generation remains available. Native PDF encryption requires a complete, audited security handler before it can be supported; no alternative backend is certified by this change.
