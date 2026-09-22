---
title: Work Inventory — a Discovery Stage Before the Intent Loop
category: Architecture
tags:
  [
    architecture,
    work-inventory,
    discovery,
    learning,
    automation-candidate,
    observation,
    consent,
    calibration,
  ]
importance: 7
author: Ecosystem Architect
last_updated: 2026-09-22
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution]
role_affinity: [ecosystem_architect, solution_architect, sovereign_concierge]
applies_to: [work_inventory, intent_loop, observation, consent, calibration]
owner: ecosystem_architect
status: active
---

# Work Inventory — a Discovery Stage Before the Intent Loop

## 1. Why a discovery stage

Kyberion's intent loop (receive → clarify → store → execute → verify → learn) starts the moment a
person states an intent. It has no answer for a prior question: **what does this person actually do,
day to day, at the keyboard, that they have never bothered to say out loud?** Traces, adhoc-pipeline
repeat-run counts, and unhandled-intent records only capture what already ran _through_ Kyberion. They
say nothing about the recurring work a member still does by hand.

Work inventory is that missing discovery stage. It sits _before_ the intent loop, not inside it: its
job is to observe and decompose recurring PC-based work into a structured record, classify each step's
likely execution method by declarative rule, and rank the result into automation candidates that a
human can then promote — through the _existing_ alignment gate and scratch → pipeline machinery — into
real intents, missions, and pipelines. Work inventory never executes anything on its own; it only feeds
candidates into the loops that already exist.

## 2. The record type: 7 stages × 12 verbs × 5 methods

One business or recurring task is one `WorkInventoryEntry` (`work-inventory.v1`,
`libs/core/work-inventory.ts`). Every entry decomposes into `steps[]`, and every step is a point in a
fixed vocabulary declared in `knowledge/product/governance/work-inventory-taxonomy.json`:

- **stage** (7): `trigger | gather | understand | decide | act | verify | record`
- **verb** (12): `receive | search | read | input | transform | judge | create | operate | communicate |
manage | record | coordinate`
- **method** (5): `api | computer_operation | ai_reasoning | program | human`

A step also carries `effects[]` (`external_send | money | personal_data | irreversible | approval`),
`data_sensitivity`, and an optional `binding` (actuator/op/pipeline/intent) once a method is settled.
Entries move through `status: draft → confirmed → candidate → promoted → retired`.

Storage is tenant-scoped: `knowledge/confidential/<tenant>/work-inventory/entries/*.json` for tenant
work, `knowledge/personal/work-inventory/entries/*.json` for personal-only use, with a sibling
`calibration.json` in each root (`libs/core/work-inventory-scoring.ts`). Every write goes through
`@agent/core/secure-io`; entries are schema-validated on save and rejected on violation.

## 3. Rules decide, models propose

An LLM may be used to turn a free-text description into a candidate step list
(`libs/core/work-inventory-decompose.ts`), including a _proposed_ method per step. That proposal is
never final. `classifyWorkStep` re-derives the method from the declarative rule table in the taxonomy
catalog — verb × conditions (`effects`, `system` binding, sensitivity) → method — and the rule's
decision always wins. When the model's proposal and the rule disagree, both are kept in the step's
`method.rationale` so the disagreement is visible, not silently discarded. The one rule with no
exception: a step whose `effects` include `money` is _always_ `human`, regardless of what any rule table
or model proposes (WI-02 acceptance criterion). A human can still override a rule's verdict
(`inventory override`), but the override itself is recorded with a reason and a `decided_by`, and a
rule that is overridden often becomes a learning signal (§6).

This split exists for the same reason RPA keeps breaking: a frozen, model-authored automation script
drifts the moment a screen changes. Declarative rules over structured steps degrade gracefully — a rule
can be inspected, versioned, and corrected — a baked-in LLM judgment cannot.

## 4. Three data channels, one privacy contract

Work inventory entries and their supporting evidence are built from three independent channels:

| Channel                  | Entry point                                                                                                                                             | What it yields                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ① Self-report            | 相棒「頼む」hearing, `scenario=work_inventory` (`/ask?mode=hearing&scenario=work_inventory`), or `pnpm inventory add`                                   | work title, trigger, frequency, effort estimate, step list    |
| ② Kyberion usage         | `pnpm inventory harvest` — trace files, repeated adhoc-pipeline runs, unhandled-intent records, mission history (`libs/core/work-inventory-harvest.ts`) | real frequency, real effort, real failures                    |
| ③ PC operation recording | consented `desktop-recording` / browser-extension recordings, summarized through `libs/core/work-inventory-observation.ts`                              | actual operation sequence (app, operation kind, host, counts) |

Channel ③ carries the sharpest privacy stakes, so it runs under an explicit invariant set:

- **Consent is the member's own, and it is recorded, not implied.** `work-inventory-consent.ts` stores
  a `consent{member_id, sources[], purpose, granted_at, expires_at, revoked_at?}` record under
  `knowledge/personal/members/<member_id>/work-inventory/consents/`. Consent windows are capped
  (`MAX_CONSENT_WINDOW_DAYS`, ≤90 days); expired, revoked, or out-of-scope recordings are rejected at
  ingest, not just at display time.
- **Clipboard and screen-frame content never cross into work inventory.** The underlying
  `desktop-recording.ts` capture already stores clipboard as a hash, never raw text; the observation
  summarizer (`work-inventory-observation.ts`) reads only operation kind, app/host, counts, and
  timestamps out of an _approved_ (`review.status === 'approved'`) recording — never input text, never
  a clipboard value, never a screen frame's pixels.
- **Raw recordings never leave the member's personal tier.** What crosses from `knowledge/personal/` to
  `knowledge/confidential/<tenant>/` is only a summary the member has explicitly confirmed
  (`status: pending_review → confirmed`, `libs/core/work-inventory-observation.ts`'s
  `confirmObservationSummary` / `attachObservationToEntry`), and that crossing is audited.

## 5. Scoring and calibration

`libs/core/work-inventory-scoring.ts` ranks entries by

```
frequency × effort_minutes × automatable_share × observation_confidence − risk
```

Weights and each method's `automatable` share live in a tenant/personal `calibration.json`, seeded from
the taxonomy's `scoring_defaults` and never hardcoded in the scoring function. Given the same entries
and the same calibration, ranking is deterministic; changing calibration changes the ranking, nothing
else (WI-06 acceptance).

## 6. Promotion and the learning cycle

A candidate never self-promotes. A human decision (`decided_by`) drives `pnpm inventory promote`,
which either produces a mission (through the same alignment-gate hand-off hearing already uses for
other scenarios) or a `pipeline:promote` input when the repetition is already confirmed
(`libs/core/work-inventory-promotion.ts`). Once promoted work actually runs, its real outcomes
(`outcomes[]` — runs, minutes saved, failures) are measured back from the promoted mission/pipeline's
own execution evidence, and `pnpm inventory learn` folds the delta between prediction and outcome back
into `calibration.json`. Work whose predicted and observed automatable share diverge sharply is also
signaled into the organization's learning-candidate queue (`operational-learning.ts`), closing the loop:

```text
collect (①②③) → bundle into an entry → classify by rule → rank candidates
  → promote (alignment gate → mission / pipeline:promote) → measure outcomes
  → recalibrate + signal the org learning queue → re-rank
```

## 7. Operator runbook

A first inventory, in order:

```bash
# 1. capture a work item (self-report)
pnpm inventory add --title "..." --trigger request --frequency week:3 --effort-minutes 30

# 2. or capture through the hearing surface instead of the CLI
#    open /ask?mode=hearing&scenario=work_inventory and answer the guided questions;
#    confirming the hand-off creates the same kind of entry

# 3. see what Kyberion already knows about how often this kind of work actually runs
pnpm inventory harvest --tenant <slug>   # omit --tenant for personal scope

# 4. (optional, channel ③) record real operation sequences under explicit, time-boxed consent
pnpm inventory consent grant --member <id> --sources desktop_recording --purpose "..." \
  --days 30 --decided-by user:<id>
pnpm inventory observe summarize --member <id> --recording <path>
pnpm inventory observe confirm --member <id> --summary <id> --decided-by user:<id>
pnpm inventory observe attach --member <id> --summary <id> --entry <entry_id> --decided-by user:<id>

# 5. rank automation candidates
pnpm inventory candidates --tenant <slug>

# 6. promote a candidate once a human has decided
pnpm inventory promote <entry_id> --kind mission --decided-by user:<id> [--execute]

# 7. after promoted work has run, fold outcomes back into calibration
pnpm inventory learn --tenant <slug>
```

Every subcommand accepts `--json` for machine output and never writes outside the caller's
tenant/personal scope.

## 8. Known limitations

- **Trace hygiene (fixed going forward, WI-13).** Every `Trace` now carries a deterministic
  `metadata.origin` (`test` / `ci` / `scheduled` / `agent` / `interactive`), derived once at
  `TraceContext` construction (`VITEST` -> test; `CI` -> ci; a `cron:`-prefixed correlationId ->
  scheduled; an agent identity env set -> agent; else interactive — see `deriveTraceOrigin` in
  `libs/core/src/trace.ts`). `pnpm inventory harvest` now drops `test`/`ci`-tagged traces entirely
  before they ever become or inflate a signal, and a `scheduled`-tagged trace marks its signal's
  `origin` `scheduled` even for a non-pipeline (`actuator_op`) signature that the
  `pipelines/<id>.json` lookup alone could never resolve. `persistTrace` also stops writing to the
  shared `active/shared/logs/traces/` store under vitest by default (opt back in per-test with
  `KYBERION_TRACE_TEST_PERSIST=1`), so the trace store a running instance harvests from no longer
  accumulates test noise at the source either.
  **Residual gap:** traces persisted before this fix (and any trace a caller writes with no
  `metadata.origin` at all) have no origin tag. Harvest still counts these — same as before, so no
  demand signal silently drops — but the CLI's `harvest` output now reports how many scanned traces
  were `excluded (test/ci)` versus `untagged (legacy, still counted)`, so the untagged fraction is
  visible and shrinks on its own as the default 28-day harvest window ages past the fix date.
- **Legacy default bindings weren't tagged `inferred` (fixed on demand, WI-17).** `fillBinding`
  (used by `applyClassification`) has tagged a candidate-default `actuator`/`op` binding
  `inferred: true` since it was introduced, but entries created earlier never got the flag even
  though their binding is exactly the verb's first taxonomy candidate — so `matchSignalsToEntries`
  could treat generic actuator traffic as if it were real evidence for that entry. Run
  `pnpm inventory migrate [--dry-run]` to backfill `inferred: true` on every entry in scope whose
  binding matches the default candidate and carries no `pipeline_id`/`intent_id`/`inferred` key
  already; explicit bindings (including an explicit `inferred: false`) are left untouched, and a
  second run is always a no-op (see `migrateInferredBindings` in `libs/core/work-inventory.ts`).
- **Scheduled runs are excluded by default.** `resolvePipelineOrigin` marks a signal `scheduled` when
  its `pipelines/<id>.json` declares an enabled `schedule`; `matchSignalsToEntries` skips `scheduled`
  signals unless the caller explicitly opts in with `includeScheduled: true`, because a cron-driven
  pipeline is system cadence, not a person's recurring manual work.
- **Desktop recordings have no per-step timestamps.** Browser-extension recordings carry
  `captured_at` per action, so an observation summary can compute a real `duration_ms`. Desktop
  recordings (`active_window` / `browser_tabs` / `focused_input` steps) carry no per-step time, so a
  desktop-only observation summary's `duration_ms` is always absent — effort for desktop-observed work
  still has to come from self-report or harvested usage data, not from the recording itself.
- **The retention catalog cannot express per-file status.** `knowledge/personal/members/<id>/work-inventory/observations/`
  mixes `pending_review`, `confirmed`, and `discarded` summaries in one directory; the storage-retention
  catalog's model is directory-level and mtime-based, so it cannot auto-expire only the unconfirmed
  ones. See `knowledge/product/governance/storage-retention-catalog.json`'s `knowledge/personal/members`
  entry for the declared gap.
