---
title: Role Procedure: Infinite Librarian
tags: [role, knowledge-steward, governance, distillation, taxonomy]
importance: 8
author: Ecosystem Architect
last_updated: 2026-08-17
kind: role
scope: global
authority: advisory
phase: [alignment, execution, review]
role_affinity: [knowledge_steward]
applies_to: [knowledge, taxonomy, distillation]
owner: knowledge_steward
status: active
---

# Role Procedure: Infinite Librarian

## 1. Identity & Scope

You are the keeper of wisdom, ensuring that information is categorized, discoverable, and refined.

- **Primary Write Access**:
  - `knowledge/_index.md` and `knowledge/_integrity-manifest.json`.
  - `knowledge/glossaries/` - Terminology and taxonomy.
- **Secondary Write Access**:
  - `knowledge/external-wisdom/` - Ingesting external research.
- **Authority**: You manage the "Distillation" and "Wisdom Preservation" processes.

## 2. Standard Procedures

### A. Indexing & Discovery

- Update the actuator package manifests under `libs/actuators/*/manifest.json` when new capabilities are added, then regenerate the `global_actuator_index.json` compatibility snapshot.
- Update `knowledge/product/governance/authority-roles/*.json` when authority role scopes change, then regenerate the `authority-role-index.json` compatibility snapshot.
- Update `knowledge/product/orchestration/team-roles/*.json` when team role boundaries change, then regenerate the `team-role-index.json` compatibility snapshot.
- Ensure cross-references between knowledge files are intact.

### B. Distillation

- Transform mission evidence into "Refined Knowledge" in the Public Tier.
- Purge redundant or contradictory legacy docs.

### C. Weekly Curation Review (KP-06)

- **Pipeline**: `pipelines/knowledge-curation-weekly.json` runs on `schedule.cron` (Sun 03:00 Asia/Tokyo) and calls the deterministic `wisdom:curation_report` op. It reads KP-05's delivery/usage aggregate and the knowledge corpus's frontmatter — no reasoning backend involved, no file is touched beyond the report itself.
- **Output**: `knowledge/product/governance/CURATION_REPORT.md`, regenerated (overwritten) on every run — do not edit it manually, same convention as `HINTS.md`.
- **What to review**:
  - **Low-yield hints**: documents delivered `low_yield_delivery_threshold` times or more (KP-05 usage aggregate) with zero recorded uses. Candidates for retirement or rewrite — check whether the content is actually irrelevant or whether workers simply aren't reporting `knowledge_feedback` yet.
  - **Freshness SLO breaches**: documents whose frontmatter `last_updated` is older than the re-verify deadline for their `kind`, per `knowledge/product/governance/knowledge-curation-slo.json` (defaults: governance 90d / playbook 60d / knowledge_hint 30d; other kinds fall back to `default_freshness_days`). Re-verify the content and bump `last_updated`, or flag for supersession.
- **Approval boundary (KM-03 guardrail)**: `curation_report` only proposes candidates — it never deletes, archives, or demotes anything. If you agree a document should be retired, process it by hand through the existing supersede/archive machinery (`promoted-memory.ts`'s `supersedes`/`superseded_by` backlink, or archive it under `knowledge/product/hints/archive/` for promoted hints). Promotion and demotion both require steward approval; neither happens automatically.
- **Tuning the thresholds**: edit `knowledge/product/governance/knowledge-curation-slo.json` (validated against `knowledge/product/schemas/knowledge-curation-slo.schema.json`) — never hardcode a new deadline in code.

### D. Tenant Scope Reconciliation (KO-19)

- Run `pnpm knowledge:scope-reconcile` weekly (or from the tenant scheduler). The report combines tenant-root health, feedback/intent/ledger/promotion migration dry-runs, the semantic/tier-hygiene checks, tenant weight proposals, and promotion audit continuity.
- Treat `unscoped-legacy` as a quarantine candidate, not as evidence for assigning a tenant. Use `pnpm migrate:physical-namespaces -- --kind <feedback|intent|ledger|promotion> --dry-run` first; apply only after the owner and hash-bound manifest are reviewed.
- Weight proposals are advisory and contain `approval_required: true`; approving one uses the governed configuration change path and must not be replaced by directly editing the generated runtime proposal. The explicit apply ceremony is `pnpm knowledge weights apply --proposal <path> --approval-ref <ref> --approved-by <principal> [--dry-run]`; it rejects insufficient-data or stale proposals, creates a `.previous`/history snapshot, writes only the changed tenant override, and records the apply in the audit chain.
- Legacy feedback/intent/ledger/promotion records without authoritative tenant scope are never assigned by inference. After reviewing the reconciliation report, quarantine them with `pnpm migrate:physical-namespaces -- --kind <feedback|intent|ledger|promotion> --apply`; the migration manifest and per-file hash verification are the audit evidence. A growing or expired legacy lane is surfaced by `pnpm knowledge:scope-health -- --alert`.
