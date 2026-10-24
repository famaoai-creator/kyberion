---
title: Event Feed Intake — pull-side sources for resident dots
category: Architecture
tags: [architecture, autonomy, dots, event-intake, feed, slack, polling]
importance: 7
author: Ecosystem Architect
last_updated: 2026-10-25
---

# Event Feed Intake

Some sources cannot push. A Slack keyword search, a ticket query and a search
result set only answer when asked. This page records how Kyberion watches them
without creating a second notification path.

## The rule

**A feed never wakes a dot.** It is a producer in front of the existing
`event-intake` path:

```
service preset (read-only)  →  feed poll  →  intake event (source + type)
                                              │
                                    event trigger (same source)  →  wake ledger → gate → dot
```

Everything downstream is unchanged: delivery-id dedupe, tenant binding from the
policy, the 24-hour payload-replay guard, the wake ledger, the wake circuit,
budget throttles and the autonomy gate. A feed that tried to wake a dot
directly would have to reimplement all of it.

The charter validator enforces the wiring: a `feed` trigger without a matching
`event` trigger on the same source is rejected at `dot validate`, because it
would ingest into a black hole.

## Push vs pull vs probe

| Trigger | Direction | Semantics                                             | Use it when                                                       |
| ------- | --------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `event` | push      | one delivered event = one wake                        | the source has a webhook (GitHub, CI, mail relay)                 |
| `feed`  | pull      | new **items** since a cursor, each becoming one event | the source only offers a list/search (Slack search, ticket query) |
| `probe` | pull      | a **condition** holds right now (fingerprint)         | you care about state ("PR left open"), not individual items       |

`probe` cannot express "the new items since last time": a sliding
`updated_since` window produces both false wakes and dropped items. That is the
gap `feed` fills.

## Durable state

One file per (dot, feed spec) under the dot state domain:
`feed/<specId>.json` (`libs/core/dot/dot-feed-source.ts`).

- `cursor` — highest observed ordering value. Slack `ts` and ISO timestamps
  both rank correctly; epoch-millisecond feeds are detected by magnitude.
- `seen` — bounded ring (500) of already-ingested item identities. Eviction is
  safe: the intake ledger still dedupes by `feed:<specId>:<itemKey>`.
- `last_poll_at` / `last_success_at` / `last_error` / `consecutive_failures` /
  `stalled_since` — the coverage evidence.
- `capped_polls` — how often the newest-window cap dropped older unseen items.

The spec id includes the query and params, so changing the query starts a new
cursor instead of silently reusing one.

## Failure behaviour

- Provider or binding failure: the poll is recorded, the interval backs off
  (2× per failure, up to 8×), and the next sweep retries. No wake is emitted.
- A feed failing twice, or not succeeding for three cadences, is reported
  `stalled`. `pnpm kyberion dot intake` shows that as a warning row — the point
  is that a blind watcher must never look healthy.
- First poll is a baseline by default. `on_first_poll: "emit"` is the explicit
  opt-in for catch-up.

## Activation table

`pnpm kyberion dot intake [--json]` is derived, never a second registry: it
reads the charters' own triggers, the intake policy and the feed state. For
each `(dot, mode, source)` it reports whether the source is declared, bound to
the same tenant, enabled on this host (and by which mechanism), the authority /
work shape / decision that bounds what the wake may do, and the feed coverage.

Use it as the review step before enabling a source: a row that is `armed: false`
or `stalled` explains itself instead of failing silently at 3 a.m.

## Slack specifically

`slack:search_messages` is a read-only preset operation (`search.messages`). It
is bounded by the token's own visibility: a user token with `search:read` sees
what that person sees; a bot token cannot search. Keyword scope (`in:#ops`,
`from:`, `after:`) belongs in the feed's `params.query`, not in a channel list,
so the watcher never becomes a tenant-wide firehose.

## Limits

- Coverage is an observation, not a backlog count: a feed cannot know what the
  provider did not return.
- No exactly-once downstream effect. The intake ledger is at-least-once across
  a crash; external side effects still need their own idempotency key.
- Polling costs a provider call per cadence per dot. Prefer one feed with a
  precise query over several broad ones.
