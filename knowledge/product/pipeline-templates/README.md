# Pipeline Templates

Canonical user-facing pipeline patterns live here.

## Preflight Rule

Every executable template must include a preflight gate before the first side-effecting step.

Required shape:

- use a reusable fragment under `pipelines/fragments/`
- emit a standard `preflight_result` channel
- keep the preflight step first, or as early as possible after immutable context setup
- fail fast on missing runtime, service auth, browser, media, or meeting prerequisites

Preferred pattern:

```json
{
  "id": "preflight",
  "role": "gate",
  "op": "core:include",
  "params": { "fragment": "fragments/<domain>-preflight.json" }
}
```

Domain-specific templates may layer additional checks, but they should not duplicate the same shell guard logic inline if a shared fragment exists.

## Instantiation

1. Copy the template to `knowledge/confidential/{tenant}/pipelines/{name}.json`
2. Fill in tenant-specific params and secrets
3. Keep the preflight gate intact unless the template is explicitly a non-executable reference
4. Run from the tenant path after validating the preflight contract

## Chronos / schedule pickup

Templates are **not** live Chronos jobs. Chronos reads a `schedule` block (`id`, `cron`, `timezone`, `enabled`) on a pipeline that has been instantiated into `pipelines/` or `knowledge/confidential/{tenant}/pipelines/`, then registered (`pnpm kyberion schedule register <id> <pipeline-path> <actuator> "<cron>"`) or picked up after `pnpm chronos` has started once.

House pattern (see `pipelines/daily-routine.json` and `pipelines/meeting-watcher.json`):

- keep `"enabled": false` on the template and on unused copies
- enable only after tenant `owner` / `repo` / secrets are filled
- do not add Slack `post_message` (or any write) to a scheduled morning job unless the write stays behind approval

`daily-github-inbox.json` ships with `schedule.enabled=false` (weekdays 08:00 Asia/Tokyo). After copy + fill-in, set `enabled: true` or register it explicitly. Delivery in the template is a local digest under `active/shared/tmp/`; Slack is an optional later step, not the default path.

## Notable templates

- `daily-github-inbox.json` — morning GitHub issue/PR/Actions capture via REST `service:preset` (`list_issues`, `list_pulls`, `actions_list_runs`). Local digest only; Slack `post_message` stays write-gated and is omitted from the default steps.
- `schedule-summary-and-coordination.json` — today's calendar + free slots via `calendar:list_calendars` / `calendar:list_events` (no `dist/` shell).
- `email-triage-workflow.json` — Gmail read/triage via `google-workspace` `gmail_triage`. Sending stays on `pnpm kyberion email deliver` / `email-actuator` and is approval-gated.
- `create-my-avatar.json` - avatar onboarding template that captures a reference photo, runs image generation through the active host bridge or fallback provider, and registers the avatar into the personal profile.
