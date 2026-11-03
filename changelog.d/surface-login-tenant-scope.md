---
category: Fixed
---

- Chronos and Presence Studio no longer show "Single sign-on is not configured" when a tenant scope is persisted with `pnpm scope use`. The stored sign-in settings and the browser-session key are operator-wide, so they are now read in system scope, as the Chronos token registry already was.
- Signing in from `127.0.0.1` no longer fails with "sign-in attempt expired". Chronos now uses the host the browser actually used instead of Next's normalized `localhost`, and `/auth/start` moves to the callback host first when two loopback names differ.
