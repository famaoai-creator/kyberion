---
category: Added
---

- **Pull feeds for resident dots** — a charter can now declare an `attention.triggers[].kind: "feed"` trigger that polls a read-only service preset (for example `slack:search_messages`) on a bounded cadence and ingests newly observed items as ordinary intake events. A feed never wakes a dot by itself: the matching `event` trigger does, so dedupe, tenant binding, budget and the wake ledger are unchanged. The first poll only records a baseline unless `on_first_poll: "emit"` is set, failing polls back off and are reported `stalled`, and a feed whose source is bound to another tenant refuses to run.
- **`pnpm kyberion dot intake`** — a derived activation table showing, per dot and source, whether it can wake the dot right now (`armed`), how the source was enabled, the accepted/emitted event types, the feed's last successful poll, and the authority role / work shape / decision that bounds what a wake may propose. Read it before enabling a source; a `stalled` row is a blind watcher.
- **`slack:search_messages`** — read-only Slack keyword search preset operation, bounded by the token's own visibility (needs a user token with `search:read`).
