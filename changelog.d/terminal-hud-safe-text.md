---
category: Fixed
---

- **Terminal HUD** — sanitized all rendered text (ANSI/control bytes, lone surrogates, overlong lines) so embedded escape sequences from logs, transcripts, or model replies can no longer corrupt or crash the terminal mid-session.
