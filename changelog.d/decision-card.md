---
category: Added
---

- **Approval requests can carry a decision card for deciding from a phone.**
  - A card states the question, the recommendation, the risk tier with its reasons, whether the action can be undone, the deadline, and evidence links. `buildDecisionCard` builds one from an autonomous ops gate result; the stricter tier wins.
  - Secret introduction and mission plan (alignment) approvals now carry cards. These requests live in the terminal and brief channels; delivering them to Telegram and Slack is not part of this change.
  - Telegram and Slack show four buttons for requests with a card: approve, request changes, reject, and ask why. Requests without a card keep approve and reject. Card text is sent without markup, so agent-written reasons cannot add links or mentions.
  - "Request changes" is recorded as a rejection with the instruction in `changeRequest`. "Ask why" returns the stored rationale and leaves the request pending.
