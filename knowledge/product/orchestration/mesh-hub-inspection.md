---
title: Mesh Hub Inspection
tags: [mesh-hub, peer, inspection, operator]
last_updated: 2026-10-31
---

# Mesh Hub Inspection

Mesh Hub の operator inspection surface は read-only です。  
目的は、受信中の peer、配送中の route、dead letter を raw JSONL を開かずに把握することです。

## Entry Point

- `pnpm mesh-hub:inspect --tenant-id <tenant>`
- `pnpm mesh-hub:inspect peers --tenant-id <tenant>`
- `pnpm mesh-hub:inspect routes --tenant-id <tenant>`
- `pnpm mesh-hub:inspect deliveries --tenant-id <tenant>`
- `pnpm mesh-hub:inspect dead-letters --tenant-id <tenant>`

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

## Notes

- The command is intentionally read-only.
- Tenant is required so inspection cannot enumerate another tenant by changing a client-side filter.
- Route explanations only expose selector, state, peer selection, and policy version.
- Payload content remains outside the inspection surface.
- topic subscription の表示は 2026-10-31 に削除しました。subscription の書き込み側（`subscribeMeshTopic`）と topic routing（`mesh-router.ts`）は 2026-10-01 に退役済みで、読み取り側は誰も書かないデータを表示していたためです。退役コードは `retired/libs-core/mesh/mesh-topic-registry.ts`、routing policy は `retired/knowledge/product/governance/mesh-hub-policy.json` にあります。
