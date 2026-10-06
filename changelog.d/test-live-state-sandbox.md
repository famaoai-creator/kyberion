---
category: Fixed
---

- **Test runs no longer write into live outboxes, audit logs, ops alerts or the inbox.** Under Vitest, those stores resolve into `active/shared/runtime/vitest-live/` (expired after a day by the janitor). Before, a full local `pnpm vitest run` queued fixture messages into the live Telegram, Discord and iMessage outboxes, so a running delivery daemon could send them. It also appended fixture events to the real audit log and system ledger, and the ledger test truncated the real system ledger and restored it afterwards. After each run, `active/shared/tmp/vitest-active-leaks.json` lists anything tests still wrote into live `active/` state. Set `KYBERION_TEST_LEAK_STRICT=1` to fail the run on a leak.
