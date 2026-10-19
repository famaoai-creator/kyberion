---
category: Added
---

- **Grant readiness and pre-meeting checks (PG-06/07)** — `pnpm kyberion grants status` lists, per kind of work (`meeting.online`, `meeting.in_room`, `voice.realtime`), which grants are still missing and the command that allows each; `pnpm meeting:preflight` shows the same as `grant.*` items. `pnpm kyberion grants upcoming` (and the opt-in `meeting-readiness-next-day` / `meeting-readiness-soon` pipelines, which notify the operator) checks the calendar's upcoming meetings ahead of time. Calendar events now carry their recurring series id, the meeting watcher passes it to `meeting:join`, and `minutes:record`, `meeting:participate` and the realtime voice CLI accept `--meeting-series` / `--meeting-url`, so a series-bound `meeting.recording` standing grant covers every occurrence.
