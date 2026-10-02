---
category: Fixed
---

- Restored the autonomous-operations alert path: `daemon_watchdog` was missing from `security-policy.json` so every unhealthy-daemon detection crashed the watchdog on `ops-alerts.jsonl` write, and `chronos_gateway` could not write `ops-alerts.jsonl`/`delegations.jsonl`, silencing the hourly health-degradation watch. Both roles now carry the scopes their authority-role cards declare.
- `backup-daily` no longer fails with "Can't add archive to itself": the tar exclude list now covers the in-repo payload archive, not only the encrypted output.
- Mission enumeration (`listMissionsInSearchDirs`) skips a search dir the caller's role cannot stat (e.g. `knowledge/personal/` under a non-personal authority) instead of aborting the whole sweep — `action-item-reminders` resumes on the tiers it may see.
- `mesh-delivery-5min` schedule is disabled; it failed every 5 minutes because `KYBERION_MESH_PEER_ID` is not configured on this node.
- Intent-drift gate no longer manufactures drift from its own recording: `mission_state` snapshots now carry the canonical mission intent (goal_summary + outcome-contract fields) instead of a ~200-char-summarized caller note, so a legitimate scope-approve stays under the blocking threshold.
- Actuator tests mock-fixes for the retry-policy catalog (`getRetryDefaults`/`loadRetryPolicy` stubs and real-file allowlists) that PR #875's abstraction merge required.
- `pnpm kyberion scheduler install --daemon agent-runtime-supervisor` is now supported, giving the agent-runtime supervisor the same launchd residency ceremony as chronos.
