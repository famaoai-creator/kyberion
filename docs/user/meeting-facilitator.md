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
- Live `meeting:participate` also checks the same mission-scoped `voice-consent.json` before recording/capture starts and again before TTS speech.
- Meeting hosts are validated before the browser join step can run.
- Meeting URLs are logged as redacted host-only values in audit/trace output.

## Consent boundary

Consent is per mission, not global. Grant it only for the meeting mission you are about to run:

```bash
pnpm meeting:consent grant \
  --mission MSN-... \
  --operator <handle> \
  --scope "recording/capture and TTS speech for <meeting purpose>" \
  --expires-at "2026-05-15T18:00:00.000Z"
```

The consent file lives in the mission evidence directory as `voice-consent.json`.
If it is missing, revoked, expired, malformed, tied to another mission, or tied
to another tenant, Kyberion fails closed. It will not start live capture, and it
will not speak.

## Dry run vs real meeting

### Dry run

Use a dry run when you want to verify the workflow contract without a live call.

```bash
pnpm cli preview pipelines/meeting-proxy-workflow.json
pnpm run test:meeting-dry-run
```

This checks the structure of the workflow and shows the intended stages
without opening a meeting. It is the right path for CI, onboarding, and
operator rehearsal.

### Real meeting

Use the participation path only when the meeting is real and the mission
has the required environment readiness.

```bash
pnpm doctor:meeting --mission MSN-...
pnpm meeting:consent grant --mission MSN-... --operator <handle>
pnpm meeting:participate \
  --mission MSN-... \
  --meeting-url "https://meet.google.com/..." \
  --platform meet
```

If the environment is missing browser or audio capability, bootstrap the
meeting runtime first and resolve the missing prerequisites before retrying.

```bash
pnpm env:bootstrap --manifest meeting-participation-runtime --apply
```

Real meeting mode can open a browser, capture meeting audio, run STT/TTS, and
write trace/audit evidence. Do not use it as a connectivity test; use the dry
run commands above until the target meeting and consent are real.

## What happens after the meeting

Kyberion can turn the transcript into action items, mark the operator's
own work as complete or blocked with a reason, and leave reminders for
other attendees. The resulting actions and trace entries stay attached to
the mission for audit and follow-up.
