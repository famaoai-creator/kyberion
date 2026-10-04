---
category: Fixed
---

- Resident-dot execution quarantines uncertain or abandoned work instead of blindly retrying possible side effects, and reconciles durable results after bookkeeping failures. Task-session execution without a governed tool executor now fails closed with explicit guidance.
- Follow-up wakes can schedule their successor at capacity. Working-memory IDs survive eviction and removal, and outcome checks require measurements after the settlement window.
- Signed webhook payloads cannot bypass replay checks by changing unsigned routing headers. Duplicate dot identities are rejected across tenant and repository charters, including manual CLI and lifecycle paths.
- Dot wake usage carries trusted dot, accounting and scope attribution on the Anthropic SDK path and on estimated CLI-backend metering (gemini/codex). Configured cost caps pause a scope only when cost attributable to it is unknown: its own usage without cost, dot/accounting-attributed usage whose scope cannot be resolved, or more than two torn history lines dated today. Unscoped operator usage (Claude Code session hooks, SDK calls outside a tenant context) never pauses a tenant; the global scope counts it and reports token-only rows as `partial` cost. Older torn lines are skipped. Ledger/metrics reconciliation by accounting ID still does not cover Claude Code session-hook usage, which carries no attribution.
- Shared lock reclamation no longer deletes uncertain ownership or races another stale-lock cleaner. Restart competing workers on upgrade; unknown or orphaned lock markers require operator inspection rather than automatic deletion.
