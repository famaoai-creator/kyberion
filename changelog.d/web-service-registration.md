---
category: Added
---

- **Local Web service registration**: register an existing GitHub or Slack access token from Concierge, then run a read-only authentication check through the preset service runtime. Token issuance remains with the service provider; repository/channel permissions, GitHub CLI login and Slack Socket Mode remain separate. Google Workspace, Microsoft 365 and Notion are not advertised as completed Web registrations.
- **Local operator boundary**: a dedicated loopback-only Concierge start command proves the real request peer without trusting forwarded headers. Existing remote authenticated startup remains available, but global credential registration, readiness and OAuth initiation are restricted to the local operator surface.
- **Credential safety**: general Settings saves preserve connection documents byte-for-byte and save service selections separately. Secret application binds approval to the initiating operator, serializes writes and uses a durable one-time claim; partial failures require explicit recovery. Verification detects credential shadowing and never returns tokens or raw provider errors.
