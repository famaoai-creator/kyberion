---
record_id: mem-MSN-WORK-CALENDAR-20261121-2026_11_21
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-WORK-CALENDAR-20261121-2026_11_21
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-21T12:22:13.405Z
source_branch: feat/work-calendar-20261121
source_commit: 1843cf2f03d0061818d38ee9db3742f0a002d613
---

# Calendar-day fields on governed records and surfaces

Store due/start days as YYYY-MM-DD with no timezone, compute on UTC day numbers, validate once in core (foundation/time isCalendarDate + a year range), and commit date inputs on blur/Enter, never per keystroke.

## Hint Scope

mission

## Trigger Phrases

- Lessons from adding WorkItem start_date/due_date and the /work calendar (MSN-WORK-CALENDAR-20261121):

1. A due date is a calendar day, not an instant: store `YYYY-MM-DD`, do grid/overdue arithmetic on UTC day numbers, format with `timeZone: UTC`, and take only "today" from the viewer local clock. Timestamps invite off-by-one days across timezones.
2. One validator: `isCalendarDate` lives in `libs/core/foundation/time.ts` (reminders re-exports it). Domain modules add their own bounds (work dates: years 1970-2999) instead of a second regex.
3. `<input type=date>` fires onChange for every segment edit, so typing a year emits 0002-, 0020-, 0202- dates. Keep a local draft, commit on blur/Enter, skip a value already sent, reset a refused one, and keep a year range on the server as the backstop.
4. Reading new record fields through surfaces: project them into workspace-graph `facts` and filter in `workspace.list` (e.g. `dated=true`) so every surface reads the viewer-scoped list instead of a new route.
5. Route parsers that import a value from a core module break tests that `vi.mock` that module wholesale; and `package-export-surface` caps new core subpaths. Prefer shape-only parsing in the route and let the store refusal (validation_error) map to a fixed 400 message (wire-error-boundary forbids raw messages).

## Recommended References

- active/missions/public/MSN-WORK-CALENDAR-20261121/evidence/implementation-report.md
- active/missions/public/MSN-WORK-CALENDAR-20261121/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-WORK-CALENDAR-20261121/evidence/implementation-report.md
- active/missions/public/MSN-WORK-CALENDAR-20261121/evidence/REVIEW-execution-implement.md

## Artifacts
