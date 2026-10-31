---
category: Security
---

- Move the Browser Bridge "Kyberion CLIへ送信" page-inspection hand-off onto Native Messaging. `pnpm kyberion browser inspect --mode extension` no longer opens an unauthenticated `127.0.0.1` HTTP listener with `Access-Control-Allow-Origin: *` (any web page could post forged inspection data while it waited). The CLI now waits on a short-lived ticket in the chosen tier/tenant staging partition (`--tier`, `--tenant`; `--extension-port` is removed), and the native host's new `submit_inspection` message validates, bounds and re-redacts the inspection (no input values, URLs without query or fragment), writes it into the waiting ticket and audits it. The side panel's port setting is gone.
- Document the meet-copilot extension's token-authenticated loopback WebSocket as an explicit exception in the Browser Bridge spec §4.2.
