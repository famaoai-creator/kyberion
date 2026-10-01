---
category: Fixed
---

- **OIDC login: limiter eviction and blocked-logout notice** — the `/auth/*` rate limiter now evicts the least recently used bucket (a hot client's bucket can no longer be reset by key rotation), and an ignored foreign `/logout` answers `403` with an explanation instead of a silent redirect.
