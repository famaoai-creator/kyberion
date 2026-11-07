---
category: Changed
---

- 設定 › メディアエンジン edits the engine runtime defaults in place instead of linking to presence-studio `/engine-config`. Covered: media binaries, recorder, streaming bridges and the agent runtime.
  - The settings are served by Concierge at `/api/voice/engine-config`.
  - Only the local operator may read or save them: a verified loopback peer, a loopback Host and a `localadmin` viewer; saves also need same-origin mutation access. This is stricter than Studio, which trusted any loopback peer.
  - Saves carry the loaded revision, so a concurrent change is a conflict, not an overwrite (Kyberion server phase 2).
