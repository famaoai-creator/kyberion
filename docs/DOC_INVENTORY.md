---
title: Documentation Inventory & Audit (Phase C'-1)
category: Planning
tags: [docs, audit, c-1, scrutiny]
importance: 8
last_updated: 2026-05-07
---

# Documentation Inventory & Audit

A scrutiny pass over `docs/` and high-level `knowledge/public/` to:

1. Identify duplicates / obsolete / sample stubs.
2. Classify the remaining docs by audience (user / operator / developer).
3. Move clearly-misplaced docs into the right tier.
4. Archive content that is no longer current but worth keeping for trend archaeology.

This is the deliverable of **Phase C'-1** in `docs/PRODUCTIZATION_ROADMAP.md`.

## 1. Actions taken (2026-05-07)

### 1.1 Archived (moved to `docs/archive/`)

| File | Reason |
|---|---|
| `LEGEND.md` | Project lore / storytelling. Not operational. |
| `PERFORMANCE_DASHBOARD.md` | Self-declared "historical pre-manifest skill telemetry snapshot". Current telemetry source is `knowledge/public/orchestration/global_actuator_index.json`. |
| `CONCEPT_INTEGRATION_BACKLOG.md` | Workflow tracking. Most P0/P1 items completed by 2026-04-20; remaining tracked in `docs/PRODUCTIZATION_ROADMAP.md`. |
| `sample_design.md`, `sample_req.md` | One-line stubs. Real samples now under `templates/verticals/` and `pipelines/`. |

### 1.2 Removed (true duplicates)

| File | Reason |
|---|---|
| `ONBOARDING.md` | Byte-identical copy of `INITIALIZATION.md`. Removed; `INITIALIZATION.md` is canonical (referenced from `AGENTS.md`/`CLAUDE.md`). |

### 1.3 Reorganized into `docs/developer/`

| Old path | New path |
|---|---|
| `docs/architecture/ARCHITECTURE_EVOLUTION_20260506.md` | `docs/developer/architecture/ARCHITECTURE_EVOLUTION_20260506.md` |
| `docs/architecture/AUTONOMY_SYSTEM_GUIDE.md` | `docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md` |
| `docs/architecture/NERVE_SYSTEM_GUIDE.md` | `docs/developer/architecture/NERVE_SYSTEM_GUIDE.md` |
| `docs/architecture/ONBOARDING_REVOLUTION.md` | `docs/developer/architecture/ONBOARDING_REVOLUTION.md` |
| `docs/architecture/POST_ONBOARDING_UX_ROADMAP.md` | `docs/developer/architecture/POST_ONBOARDING_UX_ROADMAP.md` |
| `docs/architecture/service-integration-plan.md` | `docs/developer/architecture/service-integration-plan.md` |
| `docs/architecture/dependency-graph.mmd` | `docs/developer/architecture/dependency-graph.mmd` |
| `docs/playbooks/AI_DLC_PLAYBOOK.md` | `docs/developer/playbooks/AI_DLC_PLAYBOOK.md` |
| `docs/playbooks/creative-whiteboard.md` | `docs/developer/playbooks/creative-whiteboard.md` |
| `docs/design/CHRONOS_A2UI_SPEC.md` | `docs/developer/design/CHRONOS_A2UI_SPEC.md` |

References updated in: `docs/COMPONENT_MAP.md`, `docs/GLOSSARY.md`, `docs/INTENT_LOOP_CONCEPT.md`, `docs/PRODUCTIZATION_ROADMAP.md`, `docs/developer/README.md`, `knowledge/public/architecture/{decision-support-design-rationale,hardening-backlog,kyberion-concept-evaluation-2026-04-26}.md`, `knowledge/public/governance/pipelines/modeling-graph.json`, `knowledge/public/roles/{performance_engineer,product_manager}/PROCEDURE.md`.

## 2. Audience classification of root-level `docs/` files

These remain at `docs/` root (not moved this pass) because they are heavily linked from `AGENTS.md` / `CLAUDE.md` / `README.md` / system-referenced material. The classification below tells contributors which audience each is for; future passes may relocate when reference churn is acceptable.

### User-facing (end users delegating work)

| File | Notes |
|---|---|
| `WHY.md` / `WHY.ja.md` | Positioning, thesis. Entry point for new visitors. |
| `QUICKSTART.md` | 5-minute getting-started. Linked from `README.md`. |
| `USE_CASES.md` | Catalog of automation scenarios (Japanese, ~1100 lines). |
| `SCENARIOS.md` | Persona-mapped scenarios linking actuators to playbooks. |
| `CEO_SCENARIOS.md` | CEO-task evaluation matrix. Audience overlap with `USE_CASES.md`; consolidate-or-archive candidate. |
| `HOWTO.md` | Operational how-to for the Intent Gateway. Audience bridge between user and operator. |

### Operator-facing (deploy / run / daily ops)

| File | Notes |
|---|---|
| `INITIALIZATION.md` | First-time setup (canonical, referenced by `AGENTS.md` Rule 7). |
| `OPERATOR_UX_GUIDE.md` | Day-to-day operations: Slack, Chronos, terminal, directories. |
| `PRIVACY.md` / `PRIVACY.ja.md` | Data flow + telemetry policy. |
| `operator/DEPLOYMENT.md` | macOS / Linux / Docker deployment runbook (new in Phase D'-3). |

### Developer-facing (extend / contribute)

| File | Notes |
|---|---|
| `COMPONENT_MAP.md` | Repository structure index. |
| `GLOSSARY.md` | Canonical term definitions. Referenced by `AGENTS.md`. |
| `INTENT_LOOP_CONCEPT.md` | The 6-stage intent loop concept (Japanese). |
| `USER_EXPERIENCE_CONTRACT.md` | Internal-vs-user-facing vocabulary contract. |
| `PACKAGING_CONTRACT.md` | ESM and workspace import discipline. |
| `DOCUMENTATION_LOCALIZATION_POLICY.md` | English/Japanese policy. |
| `ROADMAP_ENGINE_REFINEMENT.md` | Internal-engine roadmap (older sibling of `PRODUCTIZATION_ROADMAP.md`). |
| `PRODUCTIZATION_ROADMAP.md` | OSS hardening + FDE-readiness roadmap (current). |
| `developer/*` | All explicitly developer-tier (Phase A–D' deliverables). |

### Cross-audience / system-referenced

| File | Notes |
|---|---|
| (root) `README.md`, `CONTRIBUTING.md`, `MAINTAINERS.md`, `CODEOWNERS`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, `LICENSE`, `CHANGELOG.md` | Standard OSS contract documents. Live at repo root by convention. |
| `AGENTS.md` (and `CLAUDE.md`/`CODEX.md`/`GEMINI.md` symlinks) | The canonical operating guide for AI agents. Edit in `AGENTS.md`. |
| `CAPABILITIES_GUIDE.md` (root) | Auto-generated actuator catalog. |

## 3. `knowledge/public/` audit (light)

The 700+ files in `knowledge/public/` are **system-referenced** (loaded by Wisdom-actuator, distillation, governance enforcement). Moving them carries higher reference-churn risk than docs/. This pass only flags **patterns** — leaves the moves to a future Phase C'-1 follow-up when the runtime can accept path renames.

### Highest-density subdirs (≥ 30 docs)

| Subdir | .md count | Status |
|---|---|---|
| `orchestration/` | 97 | Live runtime references. Don't touch. |
| `architecture/` | 92 | Mix of live + historical. **Spot-check candidates for archive**: see §3.1 below. |
| `procedures/` | 74 | Live runtime hint catalog. |
| `roles/` | 57 | Live persona definitions. |
| `templates/` | 56 | Mix of templates and reference docs. |
| `external-wisdom/` | 39 | Imported from external sources. Treat as read-only library. |

### 3.1 `knowledge/public/architecture/` — candidates for spot-check

Files with names suggesting "snapshot at a point in time" or one-off evaluation:

| File | Why it might be archive-worthy |
|---|---|
| `kyberion-concept-evaluation-2026-04-26.md` | Date in title — likely a one-time evaluation. |
| `analysis-multi-tenant-governance-20260304.md` | Date in title. |
| `analysis-sensory-alignment-20260305.md` | Date in title. |
| `ARCHITECTURE_EVOLUTION_20260506.md` | Already moved to `developer/architecture/`. |

**Decision deferred** to a follow-up — these are still referenced in active material, so archiving needs a conscious cut date.

### 3.2 Generated artifact dirs

| Subdir | Action |
|---|---|
| `common/patterns/generated/` | **Reset on 2026-05-07** (Phase C'-1 + Phase B-3 work). 184 fallback test artifacts deleted; the emitter now refuses to write meaningless candidates. See `libs/core/promoted-memory.ts` `isMeaningfulPromotionCandidate`. |
| `common/operations/generated/` | Currently empty in public tier. Safe. |
| `common/wisdom/generated/` | Currently empty in public tier. Safe. |
| `common/templates/generated/` | Currently empty in public tier. Safe. |

## 4. Recommended next passes

(Out of scope for this Phase C'-1 deliverable; recorded for future work.)

- **Move root-level `docs/*.md` to user/operator/developer/ when reference churn is acceptable.** Move plan: `INITIALIZATION.md` → `operator/`, `USE_CASES.md` → `user/`, `OPERATOR_UX_GUIDE.md` → `operator/`, `COMPONENT_MAP.md` → `developer/`, `GLOSSARY.md` → `developer/`, `INTENT_LOOP_CONCEPT.md` → `developer/`, `PACKAGING_CONTRACT.md` → `developer/`, `USER_EXPERIENCE_CONTRACT.md` → `developer/`, `DOCUMENTATION_LOCALIZATION_POLICY.md` → `developer/`, `ROADMAP_ENGINE_REFINEMENT.md` → `developer/`. Each move requires updating cross-refs.
- **Consolidate `CEO_SCENARIOS.md` into `USE_CASES.md`** or archive — overlap is significant.
- **Cut date for `knowledge/public/architecture/`** — pick a date (e.g. 2026-01-01) and archive snapshot-style docs older than that.
- **Test-emitter discipline** — mirror the value-threshold pattern from `promoted-memory.ts` to any other generator that writes into committed `knowledge/public/`.

## 5. Numbers

| Metric | Before | After (this pass) |
|---|---|---|
| Files in `docs/` root (.md) | 26 | 19 |
| Subdirs under `docs/` | 5 (`architecture`, `playbooks`, `design`, `developer`, `operator`, `user`) | 4 (`developer`, `operator`, `user`, `archive`) |
| Files in `docs/archive/` | 0 | 6 (5 obsolete + README) |
| Files moved into `docs/developer/` | 14 (Phase A/B/C'/D' work) | 24 (added 10 from `architecture/`/`playbooks/`/`design/`) |
| Stale references to old paths | 11 | 0 |
| Generated patterns under `knowledge/public/common/patterns/generated/` | 184 (test fixtures) | 1 (README) |

## 6. Discoverable from this pass

The following inconsistencies were noticed but **not** changed in this pass (recorded so they can be addressed later):

- `CEO_SCENARIOS.md`, `SCENARIOS.md`, `USE_CASES.md` are three scenario docs with overlapping but not identical content. Pick one canonical and consolidate.
- The `ROADMAP_ENGINE_REFINEMENT.md` and `PRODUCTIZATION_ROADMAP.md` coexist intentionally (engine internals vs. external surface), but cross-linking between them could be tighter.
- `docs/PACKAGING_CONTRACT.md` and `docs/developer/EXTENSION_POINTS.md` overlap on stable surfaces; merge candidates after the next minor.
- Several `knowledge/public/` subdirs are nearly empty (`browser-scenarios`, `classifiers`, `terraform`, `test-runners`, `project-health`) — likely placeholders that never got content.
