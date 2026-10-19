---
title: meet-copilot live verification runbook
tags: [meet, chrome-extension, e2e, verification, captions]
last_updated: 2026-10-19
---

# Meet Copilot live verification

Lessons from MSN-MEET-E2E-20261018, the first true live E2E of the
chrome-extension meeting driver.

- The driver's join cmd carries `mic`/`camera` as `'on'|'off'` strings;
  `background.js parseControlMessage` must accept them (validator silently
  dropped every join when it required booleans).
- `findMeetTab()` must match the requested URL pathname — `tabs[0]` picks
  `meet.google.com/home` and joins the wrong surface.
- Meet caption DOM drifts: live selectors on 2026-10 were `div[class*="nMcdL"]`
  (cumulative text block) and `div[jsname="giiMnc"]` (overlay root). Tune via
  popup **Diagnose DOM** → `meeting-diagnostics-<session>.json`.
- Operator flow: `KYBERION_MEET_EXTENSION_TOKEN` (32+ chars, env registry
  secret) + same token in popup → `--driver chrome-extension` →
  `captions_first` works without any audio routing; `transcribe_first`
  additionally needs BlackHole output routing + a real STT bridge
  (`KYBERION_STT_COMMAND`, e.g. managed mlx_whisper venv wrapper).
- MV3 re-injection: `executeScript` reads content.js from disk, but the
  `__kyberionMeetCopilot` page guard blocks re-eval — a real page reload is
  required to pick up content.js changes mid-session.
