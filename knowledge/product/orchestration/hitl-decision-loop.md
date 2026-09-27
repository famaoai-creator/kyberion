---
title: HITL Decision Loop — when a human is asked, and how
category: Orchestration
tags: [orchestration, autonomy, approval, hitl, decision-card, veto-window, digest, mobile]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-28
---

# HITL Decision Loop

One contract for every "does a human need to look at this?" moment. Agents never decide their own
intervention level; the autonomous-ops gate does. The operator never has to guess what silence means:
every card says what happens if nobody answers.

Plan and status: `docs/developer/improvement-plans-2026-09/AUTONOMOUS_OPERATION_MOBILE_DECISION_PLAN_2026-09-27.ja.md` (P1-6 to P1-8).

## 1. Four intervention levels

`resolveInterventionLevel()` in `libs/core/approval-decision-card.ts` maps the gate result:

| Level    | Gate                                  | Agent                       | Operator                             | Phone rings?                       |
| -------- | ------------------------------------- | --------------------------- | ------------------------------------ | ---------------------------------- |
| `none`   | `auto`                                | proceeds                    | nothing; listed in the digest        | no                                 |
| `fyi`    | `notify`                              | proceeds                    | nothing; listed in the digest        | no                                 |
| `veto`   | `notify` + `veto_window_minutes`      | parks, resumes when settled | acts **only to object**              | once, when the card is sent        |
| `decide` | `approve` (score, escalation, shadow) | parks, does other work      | **must decide**; the request expires | once (digest if `blocking: false`) |

Reminders go through the digest, never repeated pushes. Parked does not mean stopped: an agent
that parks one action picks up other work and resumes when the approval-store request settles.

## 2. The decision card

Stored on the approval record (`decisionCard`) and rendered identically on every surface, in a
fixed order so the operator learns where to look:

1. level badge (🔴 decide / 🟡 veto / 🔵 fyi / ⚪ none) and a trial-mode marker for shadow actions
2. **what to decide** — one sentence
3. **recommendation** — approve / reject / revise, with the reason
4. **why a human** — the gate escalations in plain words (high-risk paths, never-auto class, maxed axis, budget, agent request)
5. **can it be undone**
6. **if you do nothing** — "stays paused until you decide", "proceeds at 14:00 unless you object", or "trial mode: nothing runs"
7. evidence links, then the reply vocabulary

Replies (any chat surface; `appr:<id>:…` tokens, or a bare word when exactly one card is pending in the chat):

| Reply                             | Effect                                                         |
| --------------------------------- | -------------------------------------------------------------- |
| `approve` / `承認`                | approve (on a veto card: proceed now)                          |
| `reject` / `却下` / `異議`        | reject (on a veto card: object and stop)                       |
| `appr:<id>:revise <instructions>` | settles as rejected with note `revise: …`; the agent redoes it |
| `appr:<id>:explain`               | answers why the card reached you; decides nothing              |

Autonomy cards are top-level notifications, so a reply is accepted only from the surface and chat
the card was delivered to (`decisionCard.deliveredVia`). The bridges still authorize the sender.

## 3. Veto windows — silence counts only if it was heard

`libs/core/approval-veto-window.ts`:

- The clock starts when a bridge **delivers** the card (`drainSurfaceOutbox` → `recordApprovalDeliveryReceipt`), not when it is queued. iMessage sends synchronously and counts as delivered on hand-off.
- Only minutes inside `active_hours` of `autonomous-ops-policy.json` count.
- Not delivered within 30 minutes → the request permanently becomes a `decide`; a late delivery cannot revive it.
- An elapsed window is settled `approved` by `policy:veto-window` with `decidedByType: service` — never presented as a human decision.
- A veto request can never carry `accountability.finalDecision: human_only`; `createApprovalRequest` refuses the combination.
- Shadow windows only record `veto_window_elapsed_shadow` and leave the request for the operator, so the real decision can be compared (P1-10).

## 4. Agent contract

Call the gate, then route; do not hand-roll notifications or approval records:

```ts
const gate = evaluateAutonomousOpsAction({ actionId: 'pr_merge_medium', changedPaths });
const routed = routeAutonomousDecision({
  role: 'mission_controller',
  gate,
  title: 'Merge PR 42',
  ask: 'Merge PR 42 (refactor, CI green) into main?',
  recommendation: { choice: 'approve', rationale: 'CI green, cross-provider review passed' },
  evidence: [prUrl],
  requestedBy: agentId,
  source: { missionId, taskId },
});
if (routed.proceed) doIt();
else if (routed.parked) parkAndContinue(routed.requestId);
```

- `blocking: false` for questions that can wait: the card goes to the digest instead of the phone.
- Ask a stricter tier with the gate's `requestedDecision`; there is no way to ask for a looser one.
- Before raising a `decide`, try another agent and `knowledge/` first (plan D, "相談の自己解決").
- A `revise` decision is a new instruction, not a retry signal: read the note and change the approach.

## 5. Operations

```bash
node dist/scripts/approval_inbox.js tick            # every few minutes: advance veto windows
node dist/scripts/approval_inbox.js digest --send   # morning and evening
node dist/scripts/approval_inbox.js digest --hours 24 --json
```

The digest headline answers "how many things need me?" (decide / veto / done). Sections: needs your
decision (oldest first), proceeds unless you object (soonest first), waiting too long (planned or
paused missions older than 3 days), done automatically (`none`/`fyi` notices and policy
decisions), expired. Route it with `per_event.decision_digest` in
`knowledge/personal/notification-preferences.json` (falls back to `default_channel`).
