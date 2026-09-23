---
title: 'Phase Protocol: Review & Distillation'
tags: [governance, lifecycle, review]
last_updated: 2026-09-23
runtime_stages: [verification, delivery, retrospective]
---

# Phase Protocol: ⑤ Review & Distillation

## Goal

Capitalize on experience and perform environmental cleansing.

## Directives

1. **Victory Condition Check**: Verify that all mission goals have been met with objective evidence.
2. **Evidence first, promotion second**: preserve raw distillation under the mission's `evidence/distillation.md`. Queueing is not approval or publication. A steward classifies its knowledge domain, selects and shapes durable lessons from the evidence set, then approves and promotes only the curated candidate.
3. **Task Closure**: Complete the final report and move the mission folder to the archive.
4. **Audit Reporting**: Include results from security scanners, test runners, and performance metrics in the final summary.
5. **Unhandled Intent Reconcile**: Run `pnpm pipeline --input pipelines/reconcile-unhandled-intents.json` during review so newly surfaced unhandled intents are written to proposals and summarized before closure.

## Distillation and promotion flow

The mission's raw distillation remains at active/missions/<TIER>/<MISSION_ID>/evidence/distillation.md. The mission controller may enqueue an unclassified candidate referencing that evidence; queueing is not approval or publication. Review the mission's full evidence set, select reusable lessons, remove mission-specific details, and write a shaped candidate with applicability, steps, triggers, or outcome and evidence references.

A steward must explicitly classify the durable knowledge domain before approval:

- product: Kyberion product behavior, architecture, or governance. Must be public and unscoped, and cite evidence paths under knowledge/public/ or active/missions/public/ (not opaque logical references); never broaden tenant-confidential evidence. A sanitized public candidate is separate work.
- organization: organizational operating knowledge, routed to tenant scope or an explicitly shared common area.
- personal: private individual knowledge, kept in the personal tier under an explicit owner_nhi namespace.
- unclassified: not publishable.

Use memory-review, then approve with memory-approve --knowledge-domain product|organization|personal. Mission candidates also require --curation-json with title, summary, content, and evidence_refs selected from the original candidate evidence. This is the steward's explicit extraction step: do not copy distillation.md wholesale. Then run memory-promote after evidence and provenance checks. The archived distillation.md remains immutable mission evidence; the promoted record is the discoverable durable knowledge, linked by source/evidence refs and candidate promoted_ref. A candidate remains visibly queued until curated/classified/approved/promoted or rejected; do not treat mission finish as promotion. Tier answers who may see the knowledge; domain answers whose durable knowledge it is. Never downgrade sensitivity by relabeling. Legacy candidates without a domain remain organization-scoped for compatibility and must be reviewed conservatively. Only curated organization knowledge_hint records update governance HINTS.md.

Example: `pnpm mission memory-approve <ID> --knowledge-domain organization --curation-json '{"title":"...","summary":"...","content":"...","evidence_refs":["active/missions/public/<ID>/evidence/distillation.md"]}' --note "Selected reusable operating lesson"`. When a public mission is archived before promotion, review resolves this stable public-mission evidence reference against its archive location.

## Constraints

- **Runtime Temp Purge**: MUST physically delete transient data from governed runtime temp paths such as `active/shared/tmp/` when the mission or review flow requires cleanup.
- **Evidence Preservation**: Retain structured execution logs and `mission-state.json` in the mission evidence folder.
- **Intel First**: Do not skip the distillation step; learnings are more valuable than code.

## Physical Enforcement

At mission completion, the agent MUST execute the finalization protocol.

- **Command**: `node dist/scripts/mission_controller.js finish <MISSION_ID>`
- **Validation**:
  - Automatic purging of governed runtime temp files.
  - Archiving the mission directory to `active/archive/missions/`.
  - Transitioning through `completed` before archive.
  - Verifying `mission-state.json` `git.latest_commit` matches the mission repository HEAD before finalization.

---

_Status: Mandated by AGENTS.md_
