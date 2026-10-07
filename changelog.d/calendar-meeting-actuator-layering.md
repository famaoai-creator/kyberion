---
category: Changed
---

- **Calendar / meeting actuators layered for extension** — the calendar backend monolith is split into `calendar-types` / `calendar-shared` / `calendar-registry` / `backends/{jxa,gws}` with registry-backed typed facades (`listCalendars`, `listEvents`, `queryFreeBusy`, `findSlots`, `createEvent`, `updateEvent`, `deleteEvent`, `listBackends`, `describeBackendCapabilities`, `scheduleInFirstSlot`); JXA-direct callers use `listCalendarsOnJxa` / `listEventsOnJxa`. The meeting actuator is split into session transport (`meeting-session.ts`) and a shared intelligence dispatch table (`meeting-op-dispatch.ts`); single-op `{ op, params }`, legacy `{ action, params }`, and pipeline envelopes are all accepted, the manifest advertises all 19 ops (1.3.0), and per-op catalog schemas replace the single loose schema. No existing call shapes were removed.
