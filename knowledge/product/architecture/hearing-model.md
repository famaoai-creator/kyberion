---
title: Hearing — one model for asking a person what the work needs
tags: [architecture, hearing, customer, decision, tenant, template, elicitation]
last_updated: 2026-11-13
concepts: [hearing, tenants-customers]
role_affinity: [planner, implementer, reviewer]
runtime_stages: [alignment, execution, review]
---

# Hearing

A **hearing** is a governed elicitation: it pursues an objective the tenant
set by collecting structured answers from a person, records them in the
decision ledger, and hands them to defined next actions. Three things are
kept apart:

| Part          | What it is                                                  | Where it lives                                                                                                                                             |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition    | The hearing template: objective, entries, options, defaults | Product: `knowledge/product/orchestration/customer-decision-templates/<id>.json`. Tenant: `knowledge/confidential/<tenant>/decisions/_templates/<id>.json` |
| Presentation  | How the person is asked: web form, conversation, avatar     | `presence/displays/customer-room/` (web form) today                                                                                                        |
| Answer record | What the person decided, against which approved version     | The SSOD decision ledger and the receipts of the case (`knowledge/confidential/<tenant>/decisions/<case>/`)                                                |

A new way of presenting a hearing (a chat, an avatar walking through a
screen) is a new presentation of the same definition, never a new definition
format or a new answer store.

## Design principles

The model answers four requirements.

1. **The tenant sets the goal.** A hearing starts from an `objective` (what the
   hearing must establish, and optional success criteria) written by the
   tenant. Product templates are defaults; a tenant's own template of the same
   id is used before the product one.
2. **The person answering is not slowed down.** They see why they are being
   asked (the objective) before the questions, answer only what was approved
   for them, and can always keep the current decision instead of writing one.
3. **Answers lead somewhere.** Every answer is a ledger decision bound to the
   approved content hash, so whatever consumes it (a mission task, a backlog
   WorkItem, the operator) can tell which version it was given.
4. **Answers can be counted.** Answers are stored as option values, typed values
   and outcomes, not as transcripts, so they can be aggregated per template
   entry without reading the person's text.

## The mechanisms today

Several mechanisms use the word "hearing". They map onto the model as follows
(as of 2026-11-13).

| Mechanism                                                                                     | Person answering           | Where the goal is defined                        | Where answers land                                    | Next action                                                                                     | Counting                                                      |
| --------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Customer decision hearing (`libs/core/customer-decision/`, `pnpm kyberion customer-decision`) | External customer (invite) | Template + tenant template + `objective` (HR-01) | Decision ledger, receipts, switches                   | Rework WorkItems for stale tasks, bolt-review routing, operator hand-off — fixed per entry kind | Learning report: overturn rates, off-option answers, comments |
| Front Desk hearing sheet (`libs/core/surface/hearing-*.ts`, `hearing-scenarios.json`)         | Operator                   | Product scenario catalog only                    | Hearing runtime record; ledger via `decisions import` | Mission brief, work inventory                                                                   | None                                                          |
| Decision-ledger hearing (`libs/core/decision-ledger/hearing-scenario.ts`)                     | Operator                   | The case's open decisions                        | Decision ledger                                       | Ledger promotion                                                                                | Verdict counts only                                           |
| Channel `requirements_hearing` mode and `meeting:hearing_session`                             | External customer / anyone | None (generated per conversation)                | Deal `requirements.json`, or the op's `output_path`   | None                                                                                            | None                                                          |

The customer decision hearing is the backbone: it already has the approved,
hash-bound definition, the external entry point and the ledger record. The
others converge onto its definition (plan item HR-05).

## Tenant templates (HR-01)

A tenant writes its own templates with:

```bash
pnpm kyberion customer-decision template put  --tenant <t> --file <template.json> --by user:<member>
pnpm kyberion customer-decision template list --tenant <t> --json
pnpm kyberion customer-decision template show --tenant <t> --template <id> --json
pnpm kyberion customer-decision draft --tenant <t> --case <c> --customer <c> --template <id> --locale ja
```

- **Text.** A product template writes every text as a user-facing-vocabulary key
  (`*_key`). A tenant cannot add vocabulary keys, so a tenant template writes
  each text inline per locale (`{"ja": "…", "en": "…"}`). Each slot takes exactly
  one of the two forms (`customer-decision-template.schema.json`). Drafting in a
  locale the text lacks is refused (`[CUSTOMER_DECISION_TEMPLATE_LOCALE_MISSING]`);
  the person is never shown another language or a key.
- **Resolution.** `draft --template <id>` uses the tenant's template of that id,
  else the product one. Tenant templates are read fresh on every call, as the
  tenant-bound `decision_ledger` role, so one tenant's template is never served
  to another. Fixed-purpose product templates (`bolt-review`) cannot be
  shadowed or written by a tenant. `learning` reads the organization defaults
  from the same template the tenant drafts from.
- **Location.** `_templates/` sits beside the cases under `decisions/`, like
  `_reports/`. The leading underscore is outside the case id grammar, so it is
  never listed or resolved as a case, and it inherits the case data's tier,
  tenant scope, authority, backup and offboarding.
- **No approval on `put`.** A template is never shown to a customer by itself.
  An agenda drafted from it reaches a customer only after `submit` approves
  that agenda's content hash, and changing a template never changes an agenda
  that already exists. `put` is schema-validated, refused for a tenant other
  than the bound one, and audited (`customer_decision` / `template_put`, ids and
  counts only).

## Objective (HR-01)

The `objective` (`statement`, optional `success_criteria`) comes from the
template or is set on a draft with `draft --objective <text>` (`none` clears it,
`--file` may carry it). It is shown at the top of the customer-room page and is
part of the agenda content hash when set; an agenda without an objective keeps
the hash it had before HR-01. Operator read models (`overview`, case detail)
keep showing ids and counts only and do not carry the objective text.

## Roadmap

The remaining items are tracked in
[HEARING_UNIFICATION_PLAN](../../../docs/developer/improvement-plans-2026-11/HEARING_UNIFICATION_PLAN_2026-11-12.ja.md):

- **HR-02** — a typed answer → next action mapping per template entry, limited to
  existing governed sinks (backlog WorkItem, operator hand-off), generalizing
  today's fixed routing; wire the brief input that nothing reads yet.
- **HR-03** — respondent experience: save and resume, an explicit "not sure /
  later" answer, required entries, an estimated time, conditional entries.
- **HR-04** — counting: per-entry answer distributions, completion rate,
  time to answer and the entry where people stop, as counts only.
- **HR-05** — presentation hints for conversational and avatar delivery as
  optional per-entry hints on the same definition (screen spotlight, expression,
  suggested replies), and the Front Desk scenario catalog and
  `meeting:hearing_session` converging onto the definition.

Related: [stance-tenant-customer-model](./stance-tenant-customer-model.md) (who the
customer is), the design history in
[CUSTOMER_DECISION_HEARING_PLAN](../../../docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md).
