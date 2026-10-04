---
category: Added
---

- **Dot autonomy L0 is true shadow** — at L0 a resident dot's proposals are recorded only: an action-ledger row with status `shadow`, a row in the autonomy shadow ledger, and a digest line. No decision card, notification or WorkItem is created. Agreement for L0 is measured against L1, which asks the operator on every proposal, so a shadow row agrees by construction; the operator judges the L0 → L1 promotion card from the shadowed proposals in the digest (outcome success is waived for that one step because nothing ran). New dispatch seam: `DotDispositionOverride` (`DOT_DISPOSITION_OVERRIDES`).
- **Dot autonomy L4 notify → auto takes effect** — an L4 dot may now proceed without a veto card on a policy `autonomy.relaxable_actions` action whose policy decision is notify, when it is reversible, touches no high-risk path, and outcomes stay on track. This is the single named exception to "never below the policy gate" (`DOT_L4_NOTIFY_TO_AUTO_EXCEPTION`, re-verified in `dotNotifyToAutoExceptionApplies`); approve, never_auto, high-risk, budget escalations and charter floors are never relaxed.
