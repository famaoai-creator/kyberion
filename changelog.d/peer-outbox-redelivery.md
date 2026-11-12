---
category: Added
---

- **Peer outbox redelivery** — a peer message whose delivery failed for a retryable reason (no response, receiver `retryable: true`, HTTP 408/425/429/502/503/504) is now re-sent with its original signed envelope. `peer:conversation-server` does this every 5 seconds by default; `--redelivery-interval-ms 0` turns it off, and `pnpm kyberion peer outbox redeliver --peer-id <local>` runs one pass by hand. Backoff starts at 5 s and doubles to 5 min, honouring the receiver's `retry_after_ms` / `Retry-After`; a message gets at most 8 attempts and is never sent after `expires_at` (1 h after `created_at` when it has none). A redelivered message completes the same sender-side bookkeeping as a first-try delivery (conversation reply, peer task delivery state). `pnpm kyberion peer outbox status --peer-id <local>` lists pending retries and everything that was not delivered.
- Never re-sent automatically: 4xx refusals, any other 5xx (a receiver handler error), failed rows written before this change (`legacy_failed`; upgrading causes no sends) and messages whose caller retries itself, such as auto replies (`caller_managed`).
- Outbox rows gain `http_status`, `disposition`, `reason`, `retry_after_ms`, `redelivery` and `recovery`, and a new row status `given_up`; readers of `GET /v1/peer/messages/outbox` that assumed only `sent` / `failed` need to accept it.
- **Changed:** a peer listener now refuses an envelope more than 5 minutes past its signed `expires_at` (HTTP 410 `envelope_expired`) instead of processing it.
