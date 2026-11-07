---
category: Fixed
---

- Store catalog validation now covers all existing state, ledger and storage-floor registrations and their effective retention-policy references, without changing custody, placement or expiry behavior.
- Governed catalog fallbacks now pass schema validation before notification, caching or return. Disabled DOT defaults remain disabled and schema-valid; missing fitness probes or organization security policy now fail explicitly instead of fabricating incomplete policy.
