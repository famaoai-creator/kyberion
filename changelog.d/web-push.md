---
category: Added
---

- **Web Push to your phone** — 設定 › 通知 has a switch to notify this device. The notification only says that something is waiting for you (decisions, questions, the digest, ops alerts) and opens the app; it never carries a title, id, tenant or amount, so nothing private passes through the browser vendors' push services. It respects quiet hours, only talks to the known browser push services, and is off until the operator sets `KYBERION_WEB_PUSH_PUBLIC_KEY` / `_PRIVATE_KEY` / `_SUBJECT` (`pnpm tsx scripts/generate_web_push_keys.ts` makes a pair). Adds the `web-push` dependency.
