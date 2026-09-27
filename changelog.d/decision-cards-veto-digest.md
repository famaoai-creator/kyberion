---
category: Added
---

- **Decision cards, veto windows and a decision digest make human involvement explicit.**
  - Every decision the agents raise has one of four levels computed by the autonomous-ops gate: `none` and `fyi` run and appear in the digest, `veto` proceeds unless the operator objects, `decide` waits for the operator. Only `veto` and `decide` notify the phone, once.
  - Decision cards render level first and always state what happens if nobody answers; gate escalations appear as plain-language reasons. On a veto card the Telegram buttons read "proceed now" and "object". Chat replies also accept the bare words `承認` / `却下` / `異議`, and `revise` as an alias of `changes`.
  - Veto windows (`approval-veto-window.ts`) start counting only after the bridge delivers the card, count only active hours, turn into a human decision if the card is not delivered within 30 minutes, and are settled as `policy:veto-window` (a service), never as a human.
  - `node dist/scripts/approval_inbox.js digest [--send]` renders the digest (headline counts, decisions waiting, vetoes about to proceed, stale missions, work done automatically); `tick` advances veto windows. The digest routes through the new `decision_digest` notification event.
  - Agents call `routeAutonomousDecision()` with the gate result and get back whether to proceed now or park the action and continue with other work.
