---
category: Fixed
---

- **Windows native secrets now resolve through the shared secret bridge** — synchronous secret consumers, including `secret-guard`, secret-introduction checks, and encrypted backup passphrase resolution, can read Windows Credential Manager entries just like macOS Keychain entries. Credential Manager targets isolate `(service, account)` identities and safely recognize legacy entries by username. The bridge reports the selected native backend, invalidates per-operation reads after writes/deletes, and keeps credential values off process arguments.
