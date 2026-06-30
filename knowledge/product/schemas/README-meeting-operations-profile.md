# Meeting Operations Profile

`meeting-operations-profile.schema.json` stores reusable preferences for meeting roles, brief questions, facilitation policy, and follow-up tracking.
The deterministic meeting environment preflight lives separately in `meeting-environment-policy.json` so setup guidance can change without editing code.

It separates:

- brief questions for the current meeting
- role selection for how Kyberion should behave in the meeting
- facilitation guardrails
- tracking policy for action items after the meeting
- exit policy for where Kyberion must stop

Use it when the request is closer to "run the meeting with me" than to "answer a question".

The profile does not define the meeting itself. The content still belongs in a meeting brief.

The live participation runtime is controlled separately by `meeting_participate` transport mode:

- `transcribe_first`: capture and transcribe first, with no speaking requirement.
- `realtime_voice`: speak back into the meeting, which requires real STT, real TTS, and explicit voice consent.
- `dry_run`: validate the path without treating missing audio or voice prerequisites as blockers.
- `voice_profile_id`: when omitted, the CLI resolves the active registry default profile; explicit ids must exist before live execution.

The role model is intentionally explicit:

- planner
- facilitator
- scribe
- executor
- decision_maker
- tracker

This keeps meeting work aligned with the same `brief-first` pattern used for booking, presentation, and narrated video tasks, while making the authority boundary visible.
