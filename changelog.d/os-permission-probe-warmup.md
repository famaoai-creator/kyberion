---
category: Added
---

- **OS permission probe and warm-up** — `pnpm kyberion permissions status` shows the real macOS microphone / camera / screen-recording state for the terminal host app without prompting, and `pnpm kyberion permissions warmup [--only …]` asks macOS ahead of time for permissions that are still undetermined. `meeting_preflight` now judges microphone permission from the real state; `KYBERION_AUDIO_PERMISSION_CONFIRMED` is only a fallback when the probe is unavailable. Design for unifying consents, approvals, egress and OS permissions: `docs/developer/improvement-plans-2026-10/PERMISSION_GRANT_UNIFICATION_PLAN_2026-10-19.ja.md`.
