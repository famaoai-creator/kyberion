---
title: PiBot Selective Absorption Model
category: Architecture
tags: [architecture, adoption, pibot, approval, policy, workflow, ux]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-22
kind: evergreen
concepts:
  [policy-category, workflow-disposition, grant, work-item, mission, surface, routing-decision]
---

# PiBot Selective Absorption Model

Kyberion absorbs selected patterns from [Pi Bot](https://github.com/w01fb0ss/PiBot)
(`w01fb0ss/PiBot` @ analysis clone under `active/shared/tmp/pibot-analysis/PiBot`,
tip around `c923b02` / v0.0.3), not the product shell.

Pi Bot is a local-first desktop multi-agent team (named Bots, group plans,
sandbox execution, approval cards). Kyberion already owns mission leases,
hash-bound approvals, tenant/tier isolation, and WorkItem/Issue semantics
([Concept Model v2](./decisions/2026-11-10-concept-model-v2.md)). Absorption
targets the gaps: human-facing plan and disposition cards, explainable
permission categories, and a regressable policy matrix — while keeping
approval-store as the only decision authority.

Companion docs:

- Analysis: [pibot-analysis](../../public/external-wisdom/pibot-analysis.md)
- Implementation plan: [PIBOT_SELECTIVE_ADOPTION_PLAN](../../../docs/developer/improvement-plans-2026-11/PIBOT_SELECTIVE_ADOPTION_PLAN_2026-11-22.ja.md)
- Related: [approval-gate-design](../governance/approval-gate-design.md), [ceo-ux](./ceo-ux.md), [USER_EXPERIENCE_CONTRACT](../../../docs/USER_EXPERIENCE_CONTRACT.md)

## Mapping (PiBot → Kyberion)

| PiBot                                       | Kyberion                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Group + coordinator                         | Mission owner lease; workers via child WorkItems / task contracts          |
| Group plan card (Start / Modify)            | Operator Interaction Packet + alignment brief; activate via approval-store |
| Step waiting → ready → running → blocked    | Child WorkItem status + claim/lease                                        |
| Handoff / acceptance                        | Evidence + review-task / gate                                              |
| Decision retry / skip / reassign / accept   | [Workflow Disposition](#workflow-disposition) on a blocked child WorkItem  |
| Verdict repair (≤2 replans)                 | Bounded mission append of fix/recheck child WorkItems                      |
| Permission never / ask / always by category | [Policy Category](#policy-category) → Grant or approval-store ask          |
| Approval card + "Why am I asked?"           | decisionCard riskReasons + surface renderer                                |
| Changes / Tasks panels                      | Concierge `/ops` mission detail (CEO surface stays summary-only)           |

Do not absorb: group social chat as a product surface, Bot avatar-centric UX,
YOLO as an enterprise default, or making any surface the approval authority.

## Policy Category

A **Policy Category** names the kind of effect an actuator operation may
attempt (for example `run_command`, `write_file`, `web`, `send_out`). It is
orthogonal to [Grant](../../../docs/GLOSSARY.md#grant) (who may do what in
which scope) and to approval assurance (how strongly a human was verified).

Evaluation shape:

1. Actuator op declares `policy_category` (+ optional effect class).
2. Evaluator prepares facts (path, domain, sandbox, script analysis).
3. Result is `allow` | `ask` | `deny` with a stable reason code.
4. `ask` always creates or binds an approval-store request (hash + presented digest).
5. `allow` with "always" semantics requires an isolation boundary when the
   platform can provide one; otherwise always is refused (Windows-equivalent).

A probe matrix (platform × level × variants) must keep reason codes stable in
CI, in the spirit of Pi Bot's `tools/dev/policy-matrix/expected.tsv`.

## Workflow Disposition

A **Workflow Disposition** is the fixed human choice on a blocked child
WorkItem after acceptance or execution failure:

| Action     | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `retry`    | Same owner, new attempt                                          |
| `skip`     | Mark skipped; dependents may proceed only if the contract allows |
| `reassign` | Different eligible owner, new attempt                            |
| `accept`   | Human accepts current evidence as sufficient                     |

The WorkItem endpoint checks viewer scope, human decision authority and the
authorized item version. Held effects and active leases require governed
recovery. Verification work cannot be skipped until the scheduler can
enforce a durable dependency halt. Failure notifications display deferral
while the surface lacks a current, authorized WorkItem snapshot. Bounded
automatic repair (append fix/recheck steps, replan ≤ 2) is separate and must
not invent a fifth silent disposition.

## Surface rules

- Reuse the existing decision-brief / decision-card / presented-digest /
  `surface-approval-ui` stack for approval Why+actions; do not invent a second
  card model. Concierge Needs You offers Allow once, Deny and Later.
  Always requires the executing session's trusted descriptor and is hidden
  in Concierge until that descriptor is available.
- Plan start/modify belongs on an Operator Interaction Packet over the existing
  plan-preview read-model, not only the `/ops` panel.
- Plan previews offer Start only when required inputs and dependencies are
  valid. The Mission changes summary leaves unmeasured diffs absent and scopes
  child WorkItems by tenant and Mission.
- Workflow Disposition is a Needs You / recovery card (greenfield); failure
  items today only expose `later`.
- CEO UX shows outcome, waiting approvals, and exceptions — not actuator names
  or raw ADF ([ceo-ux](./ceo-ux.md)).
- Store first: [approval-gate-design](../governance/approval-gate-design.md).
  Approval-store settle remains binary (`approved`/`rejected`); Always maps to
  approve plus a process-session cache (session standing grant). Disposition
  actions use the WorkItem recovery path when they are not a binary
  approve/reject.
- **PR #1563 continuity**: same-tenant `credential.use` Grant approvals require
  the tenant Owner on both terminal and Concierge (`APPROVAL_TENANT_OWNER_REQUIRED`).
  One stored approval is the continuity point — the CLI resumes Grant issuance
  from that decision. On those cards, PiBot **Always** is disabled
  (`grant_resume_not_session_always`); Owner **Allow once** is the correct path.
