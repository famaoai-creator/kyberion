# Customer Policy Overrides

Place customer-specific policy override files here. They override defaults from `knowledge/public/governance/*.json`.

Common overrides:

| File | Overrides |
|---|---|
| `approval-policy.json` | Who must approve which kinds of actions. |
| `path-scope-policy.json` | Customer-specific path scoping rules. |
| `security-policy.json` | Customer-specific security constraints. |
| `mission-classification-policy.json` | Customer-specific mission types. |

Only include the fields that differ from the public default — Kyberion deep-merges customer overrides on top of public defaults.
