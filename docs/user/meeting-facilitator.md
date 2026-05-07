# Meeting Facilitator Use Case

Kyberion can participate in a meeting on the operator's behalf, listen,
capture action items, and help track follow-up work. The workflow is
designed to fail closed: speaking requires explicit consent, and browser
targets are allow-listed before the join step starts.

## When to use it

Use this path when you want Kyberion to:

- join a scheduled meeting,
- capture a transcript or summary,
- extract action items,
- complete the operator's own follow-up work, and
- record an audit trail for later review.

## What is safe by default

- `join`, `listen`, `chat`, and `leave` are available without speaking consent.
- `speak` is blocked unless the active mission has a granted `voice-consent.json`.
- Meeting hosts are validated before the browser join step can run.

## Dry run vs real meeting

### Dry run

Use a dry run when you want to verify the workflow contract without a live call.

```bash
pnpm cli preview pipelines/meeting-proxy-workflow.json
```

This checks the structure of the workflow and shows the intended stages
without opening a meeting.

### Real meeting

Use the participation path only when the meeting is real and the mission
has the required environment readiness.

```bash
pnpm meeting:consent grant --mission MSN-... --operator <handle>
pnpm meeting:participate \
  --mission MSN-... \
  --meeting-url "https://meet.google.com/..." \
  --platform meet
```

If the environment is missing browser or audio capability, bootstrap the
meeting runtime first and resolve the missing prerequisites before retrying.

## What happens after the meeting

Kyberion can turn the transcript into action items, mark the operator's
own work as complete or blocked with a reason, and leave reminders for
other attendees. The resulting actions and trace entries stay attached to
the mission for audit and follow-up.
