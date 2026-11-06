---
category: Changed
---

- DOT result storage now uses a shared synchronous resource-grant issuer for opaque token lifetime, exact frozen-scope identity, and revocation on return or error. Existing DOT role, root/target binding, origin and content checks remain mandatory. Identical issuer labels or copied tokens cannot authenticate a DOT grant.
