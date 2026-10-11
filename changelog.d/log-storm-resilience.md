---
category: Fixed
---

- **Daemon logs no longer self-amplify into disk-eating storms.**
  - A dead console (daemonized stderr, `EIO` on a closed pipe) previously re-entered through the `uncaughtException` guard on every log line (~90 lines/s, ~8 GB/day, 60 MB rotation window overwritten in minutes). Console writes are now never-throwing: a broken stream is parked for the process lifetime while file recording continues.
  - Identical process-guard failures emit at most one line per 60 seconds with the suppressed count attached; guard details are capped at 2,000 chars per line.
  - Chronos warns once per hour per identical await-state scan error (corrupt journals that stay corrupt) instead of on every tick; archived-tenant schedule skips moved from `info` to `debug`.
