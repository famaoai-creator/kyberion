---
category: Changed
---

- **The autonomous ops gate computes tiers from the decision-rights matrix.**
  - `autonomous-ops-policy.json` 1.1.0 adds the matrix v2 actions (PR merge, conflict resolution, mission start, CI autofix, revert, secret mutation) in shadow mode: the gate computes their tier but never allows them to execute yet.
  - The gate raises the score-based tier when a change touches a `high_risk_paths` glob, when the action class is in `never_auto`, when any axis is at 3 (approve), or when reversibility is 2 or more (at least notify). The rules that fired are listed in the result's `escalations`.
  - An agent can ask for a stricter tier with `requestedDecision`, never a looser one.
  - Tenant overrides now only tighten a policy: axis scores take the higher value and budget caps the lower one. Overrides that previously lowered scores no longer do.
