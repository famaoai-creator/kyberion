---
category: Added
---

- **Decision cards, veto windows and a decision digest make human involvement explicit.**
  - Every decision the agents raise has one of four levels computed by the autonomous-ops gate: `none` and `fyi` run and appear in the digest, `veto` proceeds unless the operator objects, `decide` waits for the operator. Only `veto` and `decide` notify the phone, once.
  - A decision card on the approval request states the question, the recommendation, why a human is needed (gate escalations in plain language), whether the action can be undone, what happens if nobody answers, and evidence links. `buildDecisionCard` builds one from a gate result, the stricter tier wins, and cards are validated on create (text limits; evidence only as `https://` URLs or repository-relative paths).
  - Secret introduction and mission plan (alignment) approvals now carry cards. These requests live in the terminal and brief channels; delivering them to Telegram and Slack is not part of this change.
  - Cards a bridge posts itself get four buttons on Telegram and Slack: approve, request changes, reject and ask why (on a veto card: proceed now and object). Those cards are sent without markup. Autonomy cards arrive through the notification outbox as text; their link and mention syntax is neutralized for the target surface. Every chat surface, Slack included, accepts text replies: `appr:<id>:approve|reject|changes <instructions>|explain`, or the bare words `承認` / `却下` / `異議` when one card is pending in the chat.
  - "Request changes" is recorded as a rejection with the instruction in `changeRequest` (`revise` is an alias). "Ask why" returns the stored rationale and leaves the request pending.
  - Veto windows (`approval-veto-window.ts`) start counting only after the bridge delivers the card, count only active hours, turn into a human decision if the card is not delivered within 30 minutes, and are settled as `policy:veto-window` (a service), never as a human.
  - `node dist/scripts/approval_inbox.js digest [--send]` renders the digest (headline counts, decisions waiting, vetoes about to proceed, stale missions, work done automatically); `tick` advances veto windows. The digest routes through the new `decision_digest` notification event.
  - Agents call `routeAutonomousDecision()` with the gate result and get back whether to proceed now or park the action and continue with other work.
