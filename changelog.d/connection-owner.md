---
category: Added
---

- **Connection owner** — service bindings carry `owner_kind` (`person` / `organization` / `operator`) and `owner_ref`. Saving validates coherence (a person connection must not carry a tenant; an organization one must name it) and makes an organization connection's owner explicit. `isBindingVisibleTo` gives surfaces the visibility rule (person: the owner only; organization: members of that tenant; operator: never on day-to-day surfaces).
- **Owner migration** — `node dist/scripts/migrate_binding_owners.js` is a dry-run by default; `--apply` backs the records up first, `--rollback <dir>` restores them, `--assign-person user:<id>` claims legacy person connections.
