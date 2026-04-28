---
title: AI-Run Meetings — Follow-up Hardening (Ops-3 / HR-2 / HR-3 / Compliance-2)
mission_id: MSN-MTG-FOLLOWUP-20260427
date: 2026-04-27
category: Incidents
tags: [meeting, action-items, partial-state, restricted-actions, manager-cc, speaker-fairness, distill]
importance: 8
---

# Follow-up Hardening for the AI-Led Meeting Facilitator

The first cut of the meeting-facilitator (`MSN-MEETING-FACILITATOR-20260427`)
shipped with three known gaps surfaced by the outcome-simulation rubric:
non-declarative items, missing provenance, and missing reminder caps.
Those landed in the original distill. This follow-up closes the
remaining four findings + two UX gaps in one wave.

## Findings closed in this round

| Finding | Severity | Mechanism |
|---|---|---|
| **Ops-3 partial-state fail-closed** | critical | New boolean field `partial_state` on `ActionItem`. The bridge sets it on `listen` whenever the capture window did not complete (timeout, dropped audio, empty transcript). `extract_action_items` propagates it onto every derived item. `isEligibleForExecution()` short-circuits to false when `partial_state=true`, so neither `execute_self_action_items` nor `track_pending_action_items` will fire on items extracted from a degraded transcript. Operators clear via `clearPartialState`. |
| **Compliance-2 restricted-action-kinds + approval-gate** | high | Pattern policy at `knowledge/public/governance/restricted-action-kinds-policy.json`. `extract_action_items` runs each title/summary through `matchRestrictedAction()` and tags hits with `restricted=true` + `restriction_rule_id`. `execute_self_action_items` skips restricted items unless `KYBERION_RESTRICTED_APPROVED_ITEMS` lists the item id (or sudo). |
| **HR-2 chain-of-command CC** | medium | `attendees[].manager_handle` propagates onto each item. `generate_reminder_message` emits a `cc[]` whenever priority=must, the item is restricted, or the per-recipient nag count crossed `KYBERION_REMINDER_CC_AFTER_N` (default 3). `track_pending_action_items` records a separate reminder line per CC channel. |
| **HR-3 speaker fairness audit** | medium | New op `wisdom:audit_speaker_fairness` aggregates `provenance.speaker_label` across the mission and emits a share-of-voice report. Default thresholds: warn when a single speaker drives >60% of total items or >70% of `must` items. Wired into the meeting-facilitation pipeline as a final step. |

## UX / driver improvements

| Item | Mechanism |
|---|---|
| Voice consent capture CLI | `pnpm meeting:consent grant|revoke|status --mission MSN-…`. Writes `evidence/voice-consent.json` and emits a `voice_consent.<verb>` audit event. Refuses overwrite of an existing grant unless `--force`. Source: `scripts/voice_consent.ts`. |
| Bridge driver hardening | `meeting-bridge.py` rewritten: per-platform host allow-list, `zoommtg://` / `msteams:/` schemes when possible, structured error envelopes, partial-state detection on `listen` (elapsed-time + empty-transcript checks), `chat`/`status` actions, cross-platform speech (macOS `say`, Linux `espeak`, Windows PowerShell). |

## Why these matter in this order

The 6-check rubric ranks fail-closed mechanisms above warning-only
mechanisms. Ops-3 is fail-closed — it will refuse to act. Compliance-2
is fail-closed for restricted patterns — `execute_self` blocks until
the operator opts the specific item id back in. HR-2 (manager CC) and
HR-3 (fairness audit) are warning-only, and that is on purpose: a
healthy meeting is not detected by an algorithm, only flagged for
operator inspection.

## How to apply

1. Voice consent is the single load-bearing gate for `speak`. Grant per
   mission: `pnpm meeting:consent grant --mission … --operator … --scope …`.
2. When the bridge reports `partial_state=true` on `listen`, treat the
   resulting items as draft until you have eyeballed the transcript and
   called `clearPartialState`.
3. The restricted-action policy is editable; tenant deployments should
   override `KYBERION_RESTRICTED_ACTIONS_POLICY` to point at a tenant-scoped
   tightened version (financial / regulatory deployments will want more
   patterns).
4. `audit_speaker_fairness` runs in the meeting-facilitation pipeline by
   default — its warn flag should be surfaced to the operator UI; it
   does not block the run.

## References

- `libs/core/action-item-store.ts` — fields, eligibility predicate, list/clear helpers
- `libs/actuators/wisdom-actuator/src/decision-ops.ts` — `extract_action_items`,
  `execute_self_action_items` (approval gate), `track_pending_action_items`
  (CC), `audit_speaker_fairness`
- `libs/actuators/meeting-actuator/meeting-bridge.py` — driver rewrite
- `scripts/voice_consent.ts` — consent CLI
- `knowledge/public/governance/restricted-action-kinds-policy.json` — policy
- `pipelines/meeting-facilitation-workflow.json` — wired fairness audit
