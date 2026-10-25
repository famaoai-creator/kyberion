---
category: Added
---

- `customer-decision draft --from-tasks --reask <tp-id,...> --by user:<member>` asks an unresolvable task question again on an open agenda. The consumer lock keeps the old link as append-only `previous_links` history, and the guard allows only that relink (old agenda closed or withdrawn, new agenda open with the same item × key and `requires_customer`). An earlier unconfirmed customer answer may show on the re-asked entry and can be confirmed by the operator.
- `customer-decision task-decisions --tenant <t> --mission <M> --task <id>` prints a task's confirmed customer decisions for direct CLI work. It is refused unless the process is bound to that active tenant, and the audit records ids only.
- Customer-decision reminders now run hourly 09:30–18:30 JST, so a reminder approved after a run goes out the same day; the approval request and `status` show the `customer-decision remind` command to send at once. Upgrade note: tenants that already installed the reminder pipeline must run `pnpm kyberion customer-decision reminders --tenant <t> --install --force` and re-approve the Chronos project trust.
