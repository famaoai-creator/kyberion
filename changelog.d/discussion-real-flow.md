---
category: Fixed
---

- **Discussion execution and saved results** — Choose an explicit scripted run or an isolated Claude/Codex provider. A single-model brief uses one bounded generation and deterministic saved minutes/brief assembly; failures remain failures, execution provenance stays visible, and interrupted real-provider rooms require a new room. Existing tenant/provider authorization is still required.
- Saved Discussion files now use room-scoped, integrity-checked retrieval. Storage failures preserve the generated draft and remain visible instead of presenting an incomplete save as success.
- Mission discovery now imports its path helper correctly, so the Discussion mission selector can list existing authorized missions instead of silently returning an empty list.
