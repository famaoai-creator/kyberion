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

- Schema: `knowledge/public/schemas/peer-network.schema.json`
- Default catalog: `knowledge/public/orchestration/peer-network.json`

## Transport model

- `peer:server` starts a Kyberion peer listener on an HTTP port.
- `peer:send` resolves a peer from the catalog and sends a signed envelope.
- Messages are stored as inbox / outbox / event JSONL records under `active/shared/runtime/peer-messaging/` and `active/shared/observability/peer-messaging/`.
- Message handling is synchronous on receipt: the recipient processes the envelope inside the HTTP request handler, then returns the ACK response only after the responder finishes.
- The response body includes `processing_mode: "synchronous_on_receive"` and `processed_at` so operators can tell when handling completed.
- There is no deferred queue in this transport yet; if the recipient needs to fan out into mission/A2A work, that happens from the responder logic after the message is accepted.

## Same-host workflow

1. Start one peer on `127.0.0.1:4100`.
2. Start another peer on `127.0.0.1:4101`.
3. Register both peers in `knowledge/public/orchestration/peer-network.json`.
4. Send a message with `pnpm peer:send --from-peer-id kyberion-local-a --to-peer-id kyberion-local-b --subject status --payload '{}'`.

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
