---
category: Fixed
---

- Strict posture and injection-triggered approval floors survive ordinary charter and decision-rights delegation and cannot reuse session approval grants. Injection floors preserve stronger base requirements such as dual-key confirmation; ordinary delegated approvals keep their existing behavior.
- **Behaviour change (system-wide, not only dots):** decision rights no longer waive policies that require `dual_key_confirmation` (tier-sensitive secrets) or any `fallback-dangerous-*` rule (shell, egress, secret, deploy). Any caller that relied on a decision-rights grant to skip those approvals now gets an approval request instead; obtain the approval (or dual-key confirmation) through the normal approval flow.
