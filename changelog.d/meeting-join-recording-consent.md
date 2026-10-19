---
category: Changed
---

- **`meeting:join` / `meeting:listen` now require recording consent** — the meeting actuator's join and listen (the path the meeting watcher uses) were not checking recording consent. They now pass the same gate as meeting participation: the mission's `voice-consent.json`, or a `meeting.recording` standing grant covering the meeting's URL or calendar series id. Without either they return `denied`. Grant ahead of time with `pnpm kyberion grants grant --capability meeting.recording --meeting-series <id> … --request-approval`.
