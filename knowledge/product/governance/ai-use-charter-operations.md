---
title: AI Use Charter operations — autonomy, information flow, and the audit loop
tags: [ai-governance, charter, autonomy, egress, audit, operations, standards]
last_updated: 2026-10-20
---

# AI Use Charter operations

How an accountable human runs an [Accountability Charter](../../../libs/core/governance/accountability-charter.ts) day to day: what runs unattended, what comes back to them, how information flow is bounded, and how the audit loop narrows autonomy. The design rationale and phase history are in [AI_USE_CHARTER_PLAN_2026-10-20.ja.md](../../../docs/developer/improvement-plans-2026-10/AI_USE_CHARTER_PLAN_2026-10-20.ja.md).

The charter is a **limit as well as a grant**. It only ever auto-allows work inside the declared envelope; anything outside it goes to a human, and the hardening rules (injection suspected, strict posture, dual-key, dangerous shell/egress/secret/deploy) are never delegated.

## The autonomy ladder

| Situation                                                                                                                         | Outcome                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Inside every limit, no external effect                                                                                            | `allow` — runs silently                                                                               |
| Inside every limit, budget at/above 80%                                                                                           | `allow_notify` — runs, operator is told once                                                          |
| Inside the envelope, external effect (`send_message_external`, `publish_public`, `payment`, `sign_contract`, `credential_change`) | `allow`, and a deterministic 5% sample by correlation id is echoed to the operator for sampling audit |
| Outside the envelope, appetite, or an unhandled policy floor                                                                      | `require_approval` — the legacy gate asks a human for **this one action**                             |
| Standing tripwire standing, or unavailable accountable human with no deputy                                                       | `stop` / safe mode — only a human can clear it                                                        |

Sampling is feedback, never a gate: a sampled action has already run. The sample is a hash of the correlation id, so a replay never double-notifies and the same action is always sampled or never.

## Information flow: facts at the entry point

An external action is allowed only with **recipient facts**: `purpose`, `recipient_class`, `categories`, `attachment_count`. Inference processors use the parallel `processor_id`/`processing_purposes`/`processing_categories` scope. The two never substitute for each other — processor facts on a recipient action are rejected outright.

- Facts are constructed at a **trusted boundary** (a validated pipeline step), never from model output and never from the untrusted approval payload. `enforceApprovalGate` ignores any `information_flow` in its payload.
- **Missing facts** on `send_message_external`/`publish_public` go to a human. **Malformed facts** are an input error, not "no facts" — the caller must not turn a bad declaration into a different decision.
- Recipient classes: `bound_customer`, `known_counterparty` (a named outside party already in a relationship — a prospect, partner or individual contact), `approved_vendor`, `public`, `unknown`. Categories: `routine_business`, `personal_data`, `sensitive_business`, `unknown`.

Declare the scope the owner delegates in the charter form:

- `recipient_purposes` — e.g. `meeting_scheduling`, `customer_service`.
- `recipient_classes` — one or more of the classes above.
- `recipient_categories` — the data categories that may leave.
- `max_attachments` — attachment budget (0..20).

The three lists are **all-or-nothing**: a purpose without a recipient class (or vice versa) cannot be checked and is rejected rather than guessed. `allow_customer_outbound` is a convenience flag that adds the fixed greeting scope (`customer_service` / `bound_customer` / `routine_business`, no attachments); the classifier that produces `routine_business` only matches a tiny exact greeting vocabulary, so anything else stays `unknown` and goes to a human. The signed acceptance statement renders the effective scope in both languages, so what the owner signs is exactly what can run.

The `confirm-appointment-calendar` template declares `purpose: meeting_scheduling`, `recipient_class: known_counterparty`, `categories: [routine_business]`, `attachment_count: 0`. A charter that delegates that same scope lets the meeting confirmation run unattended; anything else is held.

## Money and atomicity

Read usage → check limits → append consumption runs inside one inter-process critical section per charter scope (`withCharterDecisionLock`). Two concurrent 60 JPY decisions against a 100 JPY daily limit cannot both see an empty ledger: the first allows and records, the second re-reads under the lock and is denied. The lock is held only for the synchronous decision, never across an external effect.

This bounds what the **gate** may spend, not what a downstream payment processor does. A payment that fails after the gate allowed it (timeout, retry, partial settlement) needs a compensating design on the execution side; until that exists, do not describe money delegation as fully transactional. Keep `per_action ≤ per_day ≤ per_month` and set `max_loss_per_incident` to the most one item may lose.

## The audit loop

`pnpm organization`-style scheduling aside, the loop is the daily Accountability Report (`buildAccountabilityReport`, also delivered by `core:accountability_report`):

1. **Usage** — executed vs. held, spend against day/month budgets, budgets near their limit.
2. **Exceptions** — denials grouped by the field an agent asked to widen (`amendment_proposals`), and information-flow denials grouped by reason, purpose, recipient class, processor and category.
3. **Narrowing / stop proposals** — repeated information-flow denials under a _delegated_ purpose/class/processor propose removing it (`narrow`); five or more in the window propose pausing autonomous egress entirely (`stop`). Proposals point at the charter field and the value to drop, and are advice only.
4. **Action** — the accountable human either accepts a **narrower** charter (re-acceptance is mandatory; scope never widens automatically) or clears a standing tripwire. Nothing in the loop rewrites a charter on its own.

High-impact, ambiguous, or new-destination work returns to a human by construction: a new recipient class, a category the charter excluded, a larger attachment, or an unknown content classification all fail closed.

## Standards map

These frameworks differ in scope and legal force. The table maps each to the control that carries it in Kyberion; it is a design reference, **not a declaration of legal compliance**.

| Source                                                                                  | Scope and force                                                                                       | Kyberion control                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Singapore IMDA, _Model AI Governance Framework for Agentic AI_                          | Non-binding guidance; strong on agent-specific oversight, human accountability and lifecycle controls | Accountability charter (named human, authority basis, appetite), per-action audit chain, stop/narrow loop                                        |
| NIST AI RMF + Generative AI Profile                                                     | Voluntary risk-management framework; "govern/map/measure/manage" and provenance                       | Info-flow envelope (map/measure), audit ledger + report (measure/manage), fail-closed gates + tripwires (govern)                                 |
| EU AI Act                                                                               | Binding regulation with phased obligations; risk-tiered, transparency and human-oversight duties      | Risk-tier by action class and reversibility, decision-rights floor preserved, human oversight for high-risk/hardened paths, records of decisions |
| Japan: PPC guidance on generative AI and personal data; AI business operator guidelines | Guidance/soft law; personal-data handling has statutory backing                                       | `personal_data`/`sensitive_business` categories are never delegated to `unknown` recipients; attestation-based processor scope; tenant isolation |
| UK Government AI Playbook                                                               | Non-binding public-sector principles; accountability and transparency                                 | Standing declarations, signed acceptance statement, operator-facing reports                                                                      |

The common thread the charter enforces is the same one the frameworks share: **a named human is accountable, the delegation is bounded in advance, the decision is recorded, and the human can stop it.**

## Residual gaps

- The Concierge charter pane does not yet render `recipient_purposes`/`recipient_classes`/`recipient_categories`/`max_attachments` or the processor fields; delegating them is API-only for now. The pane carries them through an amendment so an owner who set them does not silently lose them, but a first-time UI owner cannot set them yet.
- Payment execution (settlement) has no compensation/rollback path; only the gate's consumption is atomic.
- `op-preflight` has no dedicated charter guard: monotonicity is carried by the gate's fail-closed evaluation and the entry-point tests, not by a separately registered preflight guard.
