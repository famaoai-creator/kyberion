---
category: Fixed
---

- **Peer senders can read the tenant peer catalog (`peer_catalog_reader`)** — `pnpm peer:conversation send-message` from a plain shell failed with `ROLE_VIOLATION` → `peer_not_found` because the recipient endpoint and HMAC secret live in `knowledge/confidential/<tenant>/connections/peer-network.json`, which only `peer:register` (as `sovereign_concierge`) could reach. `sendPeerConversationMessageToPeer` now resolves that catalog under a new least-privilege shared core role, `peer_catalog_reader`, bound to the sending tenant: it reads that single file only, never another tenant's catalog or any other confidential file, and writes nothing. An explicit `catalogPath` or `KYBERION_PEER_NETWORK_CATALOG` override keeps the caller's own role.
