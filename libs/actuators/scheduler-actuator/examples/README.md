# scheduler-actuator examples

Declaration-only schedule store. This actuator never runs anything on its own:
it persists cron declarations as JSON under
`active/shared/runtime/scheduler/` so a runner can pick them up later.
`fire` returns a stored payload for a manual trigger.

## Schedule a weekly brief

```json
{
  "op": "schedule",
  "params": {
    "id": "sch-weekly-brief",
    "cron": "0 9 * * 1",
    "payload": { "pipeline": "pipelines/weekly-brief.json" }
  }
}
```

Omit `id` to auto-generate one (`sch-<time>-<rand>`). `enabled` defaults to `true`.

## List declarations

```json
{ "op": "list", "params": {} }
```

Returns an array of `{ id, cron, payload, enabled, created_at, updated_at }`.

## Manually fire a schedule

```json
{ "op": "fire", "params": { "id": "sch-weekly-brief" } }
```

Returns `{ id, cron, payload, enabled, fired_at }`. Execution stays with the caller.

## Cancel a schedule

```json
{ "op": "cancel", "params": { "id": "sch-weekly-brief" } }
```

Returns `{ "id": "sch-weekly-brief", "cancelled": true }`.

## Cron format

Minimal validation: exactly 5 space-separated fields
(minute hour day month weekday), e.g. `0 9 * * 1`, `*/15 * * * *`.
