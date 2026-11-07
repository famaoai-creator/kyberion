---
category: Security
---

- **Credential read lifetime** — credential-material grants use the shared
  synchronous issuer and must remain active at every I/O policy check. Queued
  callbacks cannot retain read authorization after the issuing callback returns.
