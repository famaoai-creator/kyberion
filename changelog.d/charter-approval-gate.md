---
category: Added
---

- **Charter-aware approval gate** — `enforceApprovalGate` accepts `charter` (scope + the action's facts, supplied by the trusted caller). Inside an active accountability charter the action runs without a per-action approval and is audited against the responsible human; outside it a human decides (even where the legacy policy needed none); a standing tripwire blocks. Hardened policies (injection suspected, strict posture, dual-key, hard-coded shell/egress/secret/deploy) are never delegable. Callers that do not pass `charter` behave exactly as before.
- **Accountability report** — `approval_inbox charter [--send] [--hours N] [--locale en]`: what ran under each charter in force, what was held for a decision, budget use, standing tripwires and charters near expiry. Schedule it daily.
