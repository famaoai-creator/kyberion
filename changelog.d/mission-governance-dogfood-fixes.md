---
category: Fixed
---

- **Organization operation references**: `operation add` now requires `--execution-ref` for `task_session`/`pipeline` kinds (reconcile parity), and reconcile resolves evidence refs whose missions moved under `active/archive/missions/`. `organization state ensure` repairs `organization_state:missing` idempotently; `organization_operator` gains org-bound shared-scope grants for delegated execution scopes.
- **Evidence freshness**: `record-evidence` stamps deliverable mtime/age into the ledger; retrospective reports `closing_burst` and `edited_after_record` signals.
- **Lifecycle signals**: kickoff warns on missing intent baseline and dirty trees; `mission suggestions` aggregates non-blocking review findings across missions; `operation add --preset runbook` shrinks registration flags.
