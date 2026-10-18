---
title: Peer Network Catalog
kind: orchestration
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [peer, messaging, transport, same-host, lan, catalog]
---

# Peer Network Catalog

Use this catalog to exchange messages between Kyberion instances.

同一 tenant の peer を初めて接続する場合は、先に [同一 tenant peer の最短手順](./same-tenant-peer-quickstart.ja.md) を実行してください。この文書は catalog、transport、collaboration の詳細を説明します。

通信パターンと trust / authority の正本は[Agent Communication and Coordination Model](../architecture/agent-communication-layer-model.md)です。same-host peer は別 Kyberion runtime 間の transport です。同じ checkout の provider CLI 同士の調整には Co-Session を使います。localhost は接続先の表現であり、認証や権限の付与ではありません。

## Files

- Schema: `knowledge/product/schemas/peer-network.schema.json`
- Default catalog: `knowledge/product/orchestration/peer-network.json`

## Transport model

- `peer:server` starts a Kyberion peer listener on an HTTP port.
- `peer:conversation-server` starts a conversation-capable Kyberion peer listener.
- `peer:register` stores a peer endpoint and shared secret in the tenant confidential catalog.
- `kyberion peer send` resolves a peer from the tenant catalog and sends a signed envelope.
- `peer:conversation` opens, sends, lists, and closes peer conversation sessions.
- `kyberion peer collaboration` lists and explicitly accepts or rejects governed proposals created from conversation handoffs.
- Messages are stored as inbox / outbox / event JSONL records under `active/shared/runtime/peer-messaging/tenants/{tenant}/peers/{peer}/` and `active/shared/observability/peer-messaging/tenants/{tenant}/peers/{peer}/`.
- Conversation sessions are stored under `active/shared/runtime/peer-conversations/tenants/{tenant}/peers/{peer}/` and `active/shared/observability/peer-conversations/tenants/{tenant}/peers/{peer}/`.
- Mesh Hub registrations, presence, capabilities, delivery ledger, proposals, and events use `.../mesh-hub/{namespace}/tenants/{tenant}/...`; a namespace may be empty.
- Direct Peer Messaging handles a received envelope synchronously and returns its success receipt after the responder finishes. Completed message IDs are deduplicated at the receiver; a concurrent duplicate receives retryable HTTP 425.
- The listener bounds responder concurrency and the number of requests waiting for a slot. Defaults are --max-inflight 8 and --max-queued 64; saturation returns retryable HTTP 503. Mesh presence publishes the listener's live capacity, which ranks eligible peers. An explicitly selected busy peer remains routable so the durable Mesh ledger can retry its retryable overload response.
- Governed Mesh requests use the persistent Mesh delivery ledger and mesh-delivery-driver: accepted deliveries survive driver restarts, retry with bounded exponential backoff, honor expiry, and move exhausted failures to dead-letter storage. The driver treats non-2xx transport receipts as retryable failures and preserves the broker's stable message ID across attempts.
- A successful Mesh delivery ACK means the receiver completed its synchronous handler. Explicit proposal acceptance and subsequent work execution remain separate states.

## Same-host workflow

同一 host でも別 Kyberion runtime として運用する場合に限り、Peer Messaging を使います。peer ID、listener port、共有 secret、runtime root / Mesh namespace を各 runtime で分けてください。同じ runtime root や journal に対する複数 writer はサポートしません。複数 provider CLI が同じ checkout を共有しているだけなら listener を起動せず Co-Session を使ってください。

1. Start one peer on `127.0.0.1:4100`.
2. Start another peer on `127.0.0.1:4101`.
3. On the sender host, register the remote peer with `pnpm peer:register --tenant-id demo --peer-id kyberion-local-b --base-url http://127.0.0.1:4101 --shared-secret-env KYBERION_PEER_SHARED_SECRET_B --exposure same_host`.
4. Send a message with `KYBERION_TENANT_ID=demo pnpm kyberion peer send --from-peer-id kyberion-local-a --to-peer-id kyberion-local-b --subject status --payload '{}'`.

## Same-host governed collaboration

Start a tenant-aware conversation peer. Supplying `--tenant-id` enrolls the peer,
advertises `peer.collaboration`, and maintains Mesh presence for the listener lifetime.

```bash
KYBERION_PEER_SHARED_SECRET='<secret>' pnpm peer:conversation-server \
  --peer-id kyberion-local-b \
  --host 127.0.0.1 \
  --port 4101 \
  --tenant-id default \
  --key-ref env:KYBERION_PEER_SHARED_SECRET
```

A `handoff` becomes a proposal only when its metadata contains a complete,
typed `collaboration_request` whose value is a valid `mesh-request`. Ordinary
conversation messages retain their existing behavior. The recipient checks the
signed sender, tenant, target peer, request kind, payload classification, and TTL
before persisting a pending proposal.

Inspect and decide proposals locally:

```bash
pnpm kyberion peer collaboration list --tenant-id default --peer-id kyberion-local-b --status pending
pnpm kyberion peer collaboration accept \
  --tenant-id default \
  --peer-id kyberion-local-b \
  --proposal-id <proposal-id> \
  --actor-id <operator-id> \
  --reason '<validation reason>'
```

Use `reject` instead of `accept` to reject a proposal. Decisions are append-only,
require an actor and reason, and cannot be overwritten. Acceptance records local
authorization only; it does not mutate mission state or automatically execute the
embedded WorkItem/A2A proposal.

## LAN workflow

1. Bind the peer listener to the machine's LAN address (`--host 192.168.x.y`). Binding to `0.0.0.0` also listens on the LAN, but the Mesh enrollment then records `127.0.0.1` as the endpoint.
2. Register the peer's LAN `base_url` in the catalog (`pnpm peer:register ... --exposure same_lan`).
3. Set `allow_local_network: true` (`same_lan` sets it).
4. Use the same `kyberion peer send` / `pnpm peer:conversation send-message` command and point it at the LAN peer ID. Each direction is verified with the receiver's own shared secret, so a two-way link needs a listener and a catalog entry on both sides.

## Conversation auto replies (opt-in)

A conversation server can answer inbound conversation messages with an LLM-generated reply, so two peers can hold a bounded autonomous conversation. It is off unless the operator names the remote peers:

```bash
KYBERION_PEER_SHARED_SECRET=... pnpm peer:conversation-server \
  --peer-id <local-peer> --host <lan-ip> --port 4100 --tenant-id <tenant> \
  --auto-reply-peers <remote-peer>[,<remote-peer>]
```

| Flag                           | Default     | Meaning                                                                      |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------- |
| `--auto-reply-peers`           | empty (off) | Remote peers whose `message` / `reply` messages get an LLM reply             |
| `--auto-reply-max-turns`       | 6           | Per-session cap on automatic replies; stops two auto-responders from looping |
| `--auto-reply-budget-per-hour` | 30          | Rolling per-peer generation budget (bounds session-rotation abuse and spend) |
| `--auto-reply-timeout-ms`      | 60000       | Generation timeout                                                           |
| `--auto-reply-concurrency`     | 1           | Worker concurrency                                                           |
| `--auto-reply-max-attempts`    | 3           | Delivery attempts per reply                                                  |
| `--auto-reply-knowledge-limit` | 5           | Tenant knowledge excerpts used to ground a reply                             |

How it works:

- The HTTP receive path only records a reply job in `active/shared/runtime/peer-messaging/tenants/<tenant>/peers/<local-peer>/reply-jobs.jsonl` (keyed by `sender:message_id`, so redelivery never answers twice) and returns a `status` ACK. One server process owns that ledger per local peer.
- A worker generates the reply with Claude through `runClaudeAgentQuery` in strict isolation (no tools, no settings/hooks/MCP, scratch working directory, minimal environment) — never through the reasoning failover chain, whose other CLIs run with tools. Peer text and knowledge excerpts are framed as untrusted data.
- The prompt uses only this session's transcript between the two peers and up to N excerpts from the tenant's confidential knowledge, read under the least-privilege role `peer_responder_reader` (never `connections/`).
- The reply goes back as `kind: reply` with `reply_to_message_id` and metadata `auto_generated` / `auto_turn`; retries reuse one message id, so the receiver deduplicates them. Generation and delivery failures are recorded separately in the ledger.

Prerequisites, because the reply sends tenant-confidential material to an external provider:

1. Record a provider attestation for the tenant (`training_use: none`, human approval): `pnpm onboarding llm attest --tenant <tenant> --provider claude --training-use none ... --request-approval`, approve with `pnpm kyberion approvals --approve <id>`, then apply with the printed command. The reasoning gate allows the confidential `zero_retention` send only with this valid attestation, and only when the tenant's `allowed_reasoning_backends` (if set) and the provider declaration permit it.
2. Allow the provider's endpoint in the tenant egress policy (tenant domain grant for `api.anthropic.com`).

Enabling a peer shares tenant knowledge excerpts with every holder of this server's shared secret, because the opt-in list is keyed by the authenticated `sender_peer_id`. Enable only peers you would show that knowledge to. Auto replies never run tools, change WorkItems, or touch missions; `handoff` messages keep the proposal-and-accept path.

## Envelope rules

- Every message is HMAC-signed with the sender/recipient shared secret.
- `tenant_id` is part of the signed envelope. The recipient rejects missing or mismatched tenant IDs, peer IDs, and invalid signatures.
- The peer catalog must declare the same tenant selected by the sender; a caller-supplied tenant never broadens access.
- Peer Messaging inbox/outbox JSONL files are durable audit records; they are not a deferred receiver queue. The HTTP success receipt includes processing_mode and processed_at after synchronous handling.
- Governed Mesh uses the separate tenant-scoped delivery ledger as its durable sender queue; its driver retries transport failures and the receiver deduplicates stable delivery message IDs.

## Tenant backup and restore

Tenant backup includes the tenant namespaces for peer messaging, conversations, and Mesh Hub runtime/observability. The archive itself is never sent as a peer payload. To notify another same-tenant peer, send only a signed `backup.artifact_reference` notification containing an encrypted artifact reference, SHA-256 hash, expiry, and `requires_explicit_acceptance: true`. The receiver accepts the reference locally and runs `pnpm backup restore --scope tenant --tenant <slug> ...`; restored peer/Mesh state is placed in `active/shared/runtime/peer-recovery-quarantine/` until re-enrollment and a fresh heartbeat are verified.

For an existing checkout that still has flat legacy records, first create a dry-run migration plan and then apply that exact plan after review:

```bash
pnpm peer:migrate-tenant-runtime
pnpm peer:migrate-tenant-runtime -- --plan active/shared/runtime/migrations/peer-tenant/manifests/<migration-id>.json --apply
```

Records without an explicit, valid tenant remain quarantined. After a tenant restore, request and resolve the human resume gate only after the peer has been re-enrolled and its heartbeat is healthy:

```bash
pnpm peer:runtime-recovery request --tenant-id <tenant> \
  --quarantine-path active/shared/runtime/peer-recovery-quarantine/tenants/<tenant>/<restore-id> \
  --requested-by <operator>
pnpm kyberion approve <approval-id> peer-recovery
pnpm peer:runtime-recovery resume --tenant-id <tenant> \
  --quarantine-path active/shared/runtime/peer-recovery-quarantine/tenants/<tenant>/<restore-id> \
  --approval-id <approval-id>
```
