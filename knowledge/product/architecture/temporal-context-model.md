---
title: Temporal Context and Calendar Workflow Model
tags: [temporal, calendar, scheduling, business-days, timezone]
last_updated: 2026-09-26
---

# Temporal Context and Calendar Workflow Model

Kyberion treats time as a shared interpretation layer rather than a property of one calendar vendor. A `TemporalContext` carries the instant, IANA timezone, working hours, business calendar, and default duration used by calendar, scheduler, and organization operations.

The workflow is:

```text
capture calendar state -> normalize temporal references -> derive slots/deadlines
-> propose a change -> obtain approval -> apply external mutation -> verify state
```

`business-calendar.ts` is part of the temporal core. It supplies Japanese bank business days and deadline projection; it does not own provider I/O. Calendar providers remain adapters behind the `calendar-provider` seam, and slot planning is provider-free once busy windows have been captured.

The `calendar-actuator:find_slots` operation is a read/derive operation. It combines provider free/busy results with timezone, working-hours, duration, and business-calendar constraints. It does not create or change an external event.

Mutation operations are also expressed as adapter capabilities. `update_event` covers rescheduling, event fields, and reminder configuration; `delete_event` covers cancellation. The actuator does not inspect Google or Microsoft specific URLs or payloads. It invokes the selected adapter capability and fails explicitly when that capability is unavailable, preserving the proposal, approval, and verification boundaries.
