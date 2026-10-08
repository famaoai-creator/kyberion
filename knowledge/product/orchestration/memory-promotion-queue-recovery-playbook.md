---
title: 'Memory Promotion Queue Recovery Playbook — draining a stuck candidate backlog'
tags: [governance, knowledge, memory-promotion, curation, maintenance]
last_updated: 2026-10-08
runtime_stages: [review]
---

# Memory Promotion Queue Recovery Playbook

How to drain `active/shared/runtime/memory/promotion-queue.jsonl` when dozens of
candidates sit at `hold`. Written after the 2026-10-05 cleanup that processed 60
queued candidates (27 promoted, ~28 rejected, 1 policy-suppressed).

The queue is append-only JSONL and mission distillation keeps enqueueing, so an
unreviewed backlog accumulates blockers that **can never self-heal** — audit refs
expire with log retention, evidence moves to the flat archive, and duplicate
physical records deadlock the group review. Recovery = reject + curated
re-enqueue, not force-approve.

## Detect

```
pnpm mission memory-queue                 # status table (queued/approved/promoted/rejected)
node --import ./scripts/ts-loader.mjs scripts/summarize_memory_promotion_queue.ts
pnpm mission memory-review <CANDIDATE_ID>   # per-candidate blockers + evidence presence
pnpm pipeline --input pipelines/knowledge-curation-weekly.json   # weekly report
```

## Blocker glossary (what actually blocks approval)

| blocker                                     | meaning                                                                               | remedy                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `missing_curation`                          | no human-curated `{title, summary, content, evidence_refs}` payload                   | supply `--curation-json` at approve (or set `curation` on re-enqueue)     |
| `unclassified_domain`                       | `knowledge_domain` unset                                                              | `--knowledge-domain product\|organization\|personal`                      |
| `missing_audit_entry`                       | the candidate's `audit_ref` points into an audit log day-file that was compacted away | **unfixable** — reject and re-enqueue (enqueue mints a fresh `audit_ref`) |
| `missing_evidence`                          | evidence refs don't resolve                                                           | rebase refs; see archive-fallback rules below                             |
| `duplicate_records` / `conflicting_records` | ≥2 physical rows share candidate_id+scope and disagree                                | reject with `allMatching`, re-enqueue ONE normalized record               |
| `missing_tenant_scope`                      | confidential candidate without a scope envelope                                       | re-enqueue with `scope: {tier, tenant_slug, scope_kind: tenant}`          |

## Domain/tier rules (approval gates)

- `product` domain requires `sensitivity_tier: public` AND **no scope** AND every
  `evidence_refs` entry under `knowledge/public/` or `active/missions/public/`.
- `organization` domain fits confidential/tenant-scoped candidates:
  `scope: {"tier":"confidential","tenant_slug":"<slug>","scope_kind":"tenant"}` —
  the record lands in `knowledge/confidential/<slug>/evolution/...` and the row
  lives in `runtime/tenants/<slug>/memory/promotion-queue.jsonl`.
- `personal` domain requires personal tier plus `owner_nhi`.

## Evidence-ref rules (non-obvious)

- The reviewer's archive fallback resolves `active/missions/public/<MSN>/...` →
  `active/archive/missions/<MSN>/...` — **public prefix only, and the archive is
  FLAT** (no tier/tenant dirs). Keep the original `active/missions/public/...`
  refs even when the mission is archived; do NOT rewrite them to archive paths
  (that would break the product-domain public-evidence rule).
- Confidential-mission refs like `active/missions/confidential/<tenant>/<MSN>/`
  have **no fallback** — rebase to the real `active/archive/missions/<MSN>/...`
  path, or use a logical ref (`mission:<MSN-ID>`, `artifact:...`) which never
  counts as missing.

## Recovery recipe (per stale candidate)

1. `memory-review <id>` — collect blockers.
2. Curate: read `distillation.md` / `retrospective.md` (the hand-written retrospective;
   generated stats are in `retrospective-stats.md`) (active mission dir, else
   `active/archive/missions/<MSN>/evidence/`). Extract the durable lesson — a
   "mission delivered X, PR merged" status report is NOT knowledge. Reject thin,
   test, probe, or already-shipped duplicates instead.
3. Reject stale rows:
   `updateMemoryPromotionCandidateStatus({candidateId, status:'rejected', allMatching:true, ...})`
   (CLI `memory-reject --all-duplicates` is equivalent).
4. Re-enqueue ONE normalized record via `createMemoryPromotionCandidate` +
   `enqueueMemoryPromotionCandidate` with a **new candidate_id** (`<old>-R1`) —
   fresh audit_ref, correct scope/domain, curated payload, resolved refs.
   Reference implementation: `active/shared/tmp/mem-queue-repair/repair-candidate.ts`
   (scratch, 2026-10-05 — promote to a script if this recurs).
5. Approve via `updateMemoryPromotionCandidateStatus({status:'approved', knowledgeDomain, curation, decidedBy, approvalChannel:'steward'})`
   or CLI `memory-approve <id> --knowledge-domain <d> --curation-json <json> --note ...`.
6. Verify `memory-review <new-id>` → `ready_to_promote`, then
   `pnpm mission memory-promote-pending` for the bulk write.

## Traps hit on 2026-10-05

- **Dedup swallows identical re-enqueues**: enqueue merges rows with the same
  `source_ref` + `content_hash(summary)` + scope — including into REJECTED rows.
  Re-enqueueing with an unchanged summary merges into the rejected record and the
  new candidate_id silently never exists. Change the summary wording.
- **Mirror rows**: tenant-scoped candidates can appear in both the global and the
  tenant queue files; `allMatching` reject covers both, but an orphan approved
  row in the global file re-triggers `duplicate_records`. Remove the stray line.
- **Review gates re-run at promote**: `memory-promote` runs the background review
  again — e.g. `bg_review_rule_provider` suppressed a record asserting provider
  behavior from a single observed case. A rejected promotion leaves the row
  `approved`; reject it explicitly with a note.
- **Tenant/archive ordering**: `pnpm tenant archive` has no dependency guard —
  wind down in order `mission cancel → project archive → org archive → tenant
archive`, or the consistency checker flags dangling references.

## Known seams found during recovery (2026-10-05)

- Audit-log retention (~days of `audit-*.jsonl`) is far shorter than candidate
  lifetime (weeks) → every long-lived legacy candidate hits `missing_audit_entry`.
  Fix direction: retain audit indexes alongside compacted logs, or re-anchor
  audit refs on requeue.
- Archive fallback ignores `active/missions/confidential/...` and
  `active/missions/personal/...` prefixes — archived non-public missions report
  `missing_evidence` although evidence exists in the flat archive.
- `check_tenant_registry_consistency` treated archived tenants/projects as live
  references — fixed to exclude archived project records and skip resolveTenant
  on non-active profiles (2026-10-05).
- `CURATION_REPORT.md` self-detects as `missing_last_updated` — cosmetic.
