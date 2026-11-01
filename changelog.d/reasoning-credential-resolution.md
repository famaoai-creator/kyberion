---
category: Fixed
---

- Resolve registered reasoning API credentials lazily from the governed connection store when the startup scan or OS keychain cannot supply them. Credential commands reuse secret-introduction authority while preserving tenant and task identity; tenant registration is rejected before collecting a personal key. Keychain registry write failures reject the operation instead of crashing the process.
