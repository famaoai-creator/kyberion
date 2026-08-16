# Mesh Hub Inspection

Mesh Hub の operator inspection surface は read-only です。  
目的は、受信中の peer、配送中の route、dead letter、topic subscription を raw JSONL を開かずに把握することです。

## Entry Point

- `pnpm mesh-hub:inspect --tenant-id <tenant>`
- `pnpm mesh-hub:inspect peers --tenant-id <tenant>`
- `pnpm mesh-hub:inspect routes --tenant-id <tenant>`
- `pnpm mesh-hub:inspect deliveries --tenant-id <tenant>`
- `pnpm mesh-hub:inspect dead-letters --tenant-id <tenant>`
- `pnpm mesh-hub:inspect topics --tenant-id <tenant>`

## Output

- `peers`
  - peer ID
  - tenant
  - source
  - heartbeat age
  - heartbeat state
  - declared capabilities
- `routes` / `deliveries`
  - delivery ID
  - request ID
  - selector
  - state
  - retry count
  - expiry
  - route explanation
- `dead-letters`
  - dead letter ID
  - delivery ID
  - failure class
  - redacted reason
- `topics`
  - tenant/topic
  - subscriber count
  - fan-out count
  - allowed request kinds

## Notes

- The command is intentionally read-only.
- Tenant is required so inspection cannot enumerate another tenant by changing a client-side filter.
- Route explanations only expose selector, state, peer selection, and policy version.
- Payload content remains outside the inspection surface.
