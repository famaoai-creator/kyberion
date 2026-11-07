# Customer Connections

Place one JSON file per external service connection here. Examples:

- `slack.json` — Slack workspace + channel routing.
- `google-workspace.json` — Google Workspace OAuth scopes + delegated user.
- `internal-api.json` — customer's internal API endpoints + auth scheme reference.

The schema follows `knowledge/personal/connections/*.json`. Real credentials live in `secret-actuator` (OS keychain) or `secrets.local.json` — **never** in these connection files.
