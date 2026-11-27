---
category: Added
---

- **Commitment Loop (calendar intake and morning digest)** — Google Calendar can be registered as an information-asset location (`collector_id: google_calendar.events`, `asset_type: calendar.meeting`). Meetings get a preparation brief before they start and follow-up action extraction after they end, both read-only. `pnpm organization information-assets commitments --tenant <slug> --organization-id <org> --self <your email>` turns completed mail and meeting intake into what you owe, what you are waiting on, upcoming meetings and unsent reply drafts. Nothing is sent or scheduled; the binding must list `calendar_events_list` in `allowed_actions`.
