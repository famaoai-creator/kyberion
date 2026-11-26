---
category: Security
---

- **Follow-up hardening for governed dot `task_session` & conversational correction capture** — Narrowed `dot_read_scoped_file` confidential reads through `resolveKnowledgeScopeSet` / `assertKnowledgePathInScope` (`organization_id` / `project_id` containment), enforced `charter.scope` ↔ `item.context` coherence and `personal` `owner_nhi` checks, verified live lease non-expiry (`listActiveWorkLeases`) and active persisted charter state on every tool call, and applied `redactSensitiveString` + `scrubContent` PII/secret filtering before persisting IL-05 conversational corrections.
