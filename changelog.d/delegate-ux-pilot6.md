---
category: Added
---

- Added `pnpm kyberion approvals --delegate <request-id>`: converts a pending charter-delegable external-operation request into an onboarding-authority grant plan in one step (registry-derived delegation target persisted on the request and re-validated, +90-day default expiry, `--expires-at` override bounded to 365 days); the human approve + apply ceremony is unchanged and non-delegable requests refuse with a reason.
- Added flag-composed charter grants to `pnpm onboarding authority preview`: `--grant <operation_id>` + repeated `--grant-field key=value` + `--expires-at <ISO>` build the exact-same validated plan input without hand-written JSON; flag-only options are rejected outside flag mode.
- `pnpm kyberion approvals` now marks charter-delegable pending requests in the listing and mentions `--delegate` in the decision summary.
