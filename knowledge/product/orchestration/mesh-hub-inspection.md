# Mesh Hub Inspection

Mesh Hub の operator inspection surface は read-only です。  
目的は、受信中の peer、配送中の route、dead letter、topic subscription を raw JSONL を開かずに把握することです。

## Entry Point

- `pnpm mesh-hub:inspect`
- `pnpm mesh-hub:inspect peers`
- `pnpm mesh-hub:inspect routes`
- `pnpm mesh-hub:inspect deliveries`
- `pnpm mesh-hub:inspect dead-letters`
- `pnpm mesh-hub:inspect topics`

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
- Route explanations only expose selector, state, peer selection, and policy version.
- Payload content remains outside the inspection surface.
