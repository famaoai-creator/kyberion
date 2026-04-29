# Meeting Operations Brief

`meeting-operations-brief.schema.json` stores the meeting-level contract Kyberion should work from before joining or facilitating a meeting.

It captures:

- the meeting title and URL
- the meeting purpose
- Kyberion's primary role
- support roles
- agenda and participants
- desired outcomes
- authority scope
- ownership for Kyberion's own tasks
- tracking expectations for other people's action items
- exit conditions

The brief is intentionally explicit about authority:

- `may_facilitate` controls whether Kyberion can drive the meeting
- `may_speak` controls whether Kyberion can speak
- `may_make_shared_decisions` controls whether shared decisions are allowed
- `may_assign_action_items` controls whether Kyberion can assign owners and deadlines
- `may_track_action_items` controls whether Kyberion may track follow-up work after the meeting

This keeps meeting behavior aligned with the same `brief-first` pattern used for booking, presentation, and narrated video work.
