# Meeting Operations Profile

`meeting-operations-profile.schema.json` stores reusable preferences for meeting roles, brief questions, facilitation policy, and follow-up tracking.

It separates:

- brief questions for the current meeting
- role selection for how Kyberion should behave in the meeting
- facilitation guardrails
- tracking policy for action items after the meeting
- exit policy for where Kyberion must stop

Use it when the request is closer to "run the meeting with me" than to "answer a question".

The profile does not define the meeting itself. The content still belongs in a meeting brief.

The role model is intentionally explicit:

- planner
- facilitator
- scribe
- executor
- decision_maker
- tracker

This keeps meeting work aligned with the same `brief-first` pattern used for booking, presentation, and narrated video tasks, while making the authority boundary visible.
