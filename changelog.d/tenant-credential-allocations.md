---
category: Added
---

- Add human-approved tenant credential allocation commands (`assign`, `allocations`, `check`, `revoke`) on the existing standing Grant store, plus `probe` through real claimed WorkItem dispatch. Local bindings revalidate approval, expiry, claim and key version before subsequent managed API consumption. API proof metadata now attributes key version, endpoint and execution scope; safe failure codes distinguish DNS, HTTP and timeout failures. Add `scope operator` and a complete tenant credential walkthrough.
- Reduce repeated Keychain requests: defer encrypted startup reads, resolve stored connections before OS fallback, memoize refusals per explicit operation, never create a replacement master while decrypting or after access refusal, and update/add without deleting first. Already running processes must be restarted to receive these changes.
