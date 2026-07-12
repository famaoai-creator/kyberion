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

## Files

- Schema: `knowledge/product/schemas/peer-network.schema.json`
- Default catalog: `knowledge/product/orchestration/peer-network.json`

## Transport model

- `peer:server` starts a Kyberion peer listener on an HTTP port.
- `peer:conversation-server` starts a conversation-capable Kyberion peer listener.
- `peer:send` resolves a peer from the catalog and sends a signed envelope.
- `peer:conversation` opens, sends, lists, and closes peer conversation sessions.
- `peer:collaboration` lists and explicitly accepts or rejects governed proposals created from conversation handoffs.
- Messages are stored as inbox / outbox / event JSONL records under `active/shared/runtime/peer-messaging/` and `active/shared/observability/peer-messaging/`.
- Conversation sessions are stored under `active/shared/runtime/peer-conversations/` and `active/shared/observability/peer-conversations/`.
- Message handling is synchronous on receipt: the recipient processes the envelope inside the HTTP request handler, then returns the ACK response only after the responder finishes.
- The response body includes `processing_mode: "synchronous_on_receive"` and `processed_at` so operators can tell when handling completed.
- There is no deferred queue in this transport yet; if the recipient needs to fan out into mission/A2A work, that happens from the responder logic after the message is accepted.

## Same-host workflow

1. Start one peer on `127.0.0.1:4100`.
2. Start another peer on `127.0.0.1:4101`.
3. Register both peers in `knowledge/product/orchestration/peer-network.json`.
4. Send a message with `pnpm peer:send --from-peer-id kyberion-local-a --to-peer-id kyberion-local-b --subject status --payload '{}'`.

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
pnpm peer:collaboration list --peer-id kyberion-local-b --status pending
pnpm peer:collaboration accept \
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

1. Bind the peer listener to `0.0.0.0` or the machine's LAN address.
2. Register the peer's LAN `base_url` in the catalog.
3. Set `allow_local_network: true`.
4. Use the same `peer:send` command and point it at the LAN peer ID.

## Envelope rules

- Every message is HMAC-signed with the sender/recipient shared secret.
- The recipient rejects mismatched peer IDs and invalid signatures.
- The transport is intentionally store-and-forward so messages remain auditable.
- Store-and-forward here means the sender records the outbound attempt, the recipient records the inbound envelope, and the final ACK is issued only after the recipient finishes synchronous handling.
