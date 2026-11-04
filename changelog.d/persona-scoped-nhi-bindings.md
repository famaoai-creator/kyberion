---
category: Added
---

- **Conversational persona and scoped identities**: Link one conversational persona to distinct existing personal and tenant NHIs with `pnpm nhi persona-bind`. Preview first, then apply the complete mapping with its `--expected-revision`. Bindings confer no grants or session admission; same-persona onboarding preserves them and populated bindings must be explicitly cleared before renaming the handle.
- **Identity boundary hardening**: New tenant admissions require exact tenant affiliation rather than matching organization names. Existing approved legacy sessions remain bounded to their recorded tenant. Runtime identity selection uses `KYBERION_NHI_ID` independently of the `KYBERION_NHI_ACTOR` policy mode. Automatic pipeline resume refuses historical snapshots missing that policy capture and directs the operator to the original runtime.
