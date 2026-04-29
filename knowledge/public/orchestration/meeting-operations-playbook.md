# Meeting Operations Playbook

Use this playbook when the user asks Kyberion to participate in, facilitate, or manage a live online meeting.
It is the canonical surface playbook for the `meeting-operations` intent.
It specializes the shared [Guided Coordination Protocol](./guided-coordination-protocol.md) for live meeting work.

## Kyberion Fit

Meeting operations should be handled as a coordination flow, not as a direct answer.
The value is in preflight, role selection, authority boundaries, live facilitation, action-item extraction, and follow-up tracking.

Use Kyberion when the task has at least one of these properties:

1. It needs a live meeting role.
2. It depends on decision authority, facilitation, or action-item tracking.
3. It should produce a reusable meeting brief and post-meeting summary.
4. It involves keeping owners, deadlines, and follow-up state coherent.

## Brief And Role Separation

Keep two layers distinct inside the shared coordination flow:

1. Brief layer: what the meeting is about, who is present, what outcomes matter, and what authority Kyberion has.
2. Role layer: whether Kyberion should act as planner, facilitator, scribe, executor, decision-maker, or tracker.

Use `meeting-operations-profile` to store the reusable role hints, the first questions Kyberion should ask, and the guardrails for speaking, joining, and tracking.

## Preflight

Before joining or speaking, decide which brief questions and role to use.

1. Read the stored `meeting-operations-profile`.
2. Pick the brief question set that matches the meeting purpose.
3. Pick the role set that matches the same purpose and authority.
4. Ask only the first 1-3 questions that would materially change the meeting brief or authority boundary.

Good fits for this preflight include planning meetings, status updates, decision meetings, workshops, incidents, one-on-ones, and reviews.

If you want to invoke the workflow directly from the terminal, this is the outcome-first form:

```bash
pnpm exec tsx scripts/run_intent.ts "Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる" --input meeting-request.json
```

Where `meeting-request.json` should provide the governed meeting context, for example:

```json
{
  "mission_id": "MSN-MTG-2026-Q2-WEEKLY",
  "meeting_url": "https://example.microsoft.com/teams/join/abc",
  "meeting_role_boundary": "facilitator",
  "meeting_purpose": "planning",
  "locale": "ja"
}
```

## Workflow

1. Intent capture: preserve the original request and extract known facts.
2. Clarification pass: ask only the questions that change the brief, role, or authority scope.
3. Brief draft: create a meeting brief with purpose, participants, outcomes, and exit conditions.
4. Role selection: choose the role hint from the profile, or ask if the choice is unclear.
5. Join preparation: verify the meeting URL, platform, and join authority.
6. Facilitation: join, listen, and speak only within the authority boundary.
7. Action items: extract items, assign owners when authorized, and record deadlines.
8. Tracking: push follow-ups into the configured tracking channel and keep them open until closed.
9. Review: propose reusable preference updates for `knowledge/personal/` only when the user approves.

The `meeting_orchestrator.ts` runner can be invoked directly once the `meeting_url` and mission context are available. It will compile the meeting brief first, then stage the live facilitation flow.

## Authority Boundary

Treat authority as a separate gate from presence in the meeting.

Safe defaults:

- join only after the meeting URL is verified
- do not speak unless authority is explicit
- do not make shared decisions unless authorized
- do not assign action items unless authorized
- always capture a final summary and action-item list when the profile allows it

## Outputs

Minimum output:

1. Current assumptions and unresolved blocking questions.
2. Brief summary and chosen role.
3. Authority summary.
4. Tracking plan.

Full output:

1. Meeting brief.
2. Role selection summary.
3. Authority scope summary.
4. Final action-item list.
5. Tracking package.
6. Personal preference update proposal.
