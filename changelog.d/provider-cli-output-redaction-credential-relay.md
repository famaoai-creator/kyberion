---
category: Security
---

- Redact secrets at every provider CLI reasoning backend exit: final answers, streamed chunks (including a key split across chunks), structured results, native-subagent metadata, and stderr-bearing errors. Redaction walks values with depth, size, and cycle bounds, and also matches JSON-escaped forms of multi-line keys.
- Add an opt-in loopback credential relay, `KYBERION_PROVIDER_CREDENTIAL_RELAY=1` (default off), for API-key mode claude and codex delegations. The child CLI gets a 127.0.0.1 base URL and a per-turn placeholder key, and the real key stays in the parent relay, which is closed at turn end. OAuth-login CLIs are unaffected.
