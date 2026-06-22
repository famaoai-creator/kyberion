# Phase Protocol: ⑤ Review & Distillation

## Goal
Capitalize on experience and perform environmental cleansing.

## Directives
1. **Victory Condition Check**: Verify that all mission goals have been met with objective evidence.
2. **Wisdom Distillation**: Extract essential learnings (logic, constraints, patterns) from mission logs and TASK_BOARD into `knowledge/`. See §Volatile Distillation Lane below.
3. **Task Closure**: Complete the final report and move the mission folder to the archive.
4. **Audit Reporting**: Include results from security scanners, test runners, and performance metrics in the final summary.

## Volatile Distillation Lane

This section is mandated by the Volatile Knowledge Layer (`docs/VOLATILE_KNOWLEDGE_PLAN.ja.md § Phase 4`).

At mission completion, before calling `mission_controller finish`:

1. **Read the mission MEMORY.md** (`active/missions/<TIER>/<MISSION_ID>/MEMORY.md`) and extract entries under `## Decisions` and `## Lessons Learned` that are worth keeping.
2. **Nominate promotion candidates** via `memory-promotion-queue` (`enqueueMemoryPromotionCandidate`). Set:
   - `source_type`: `'mission'`
   - `source_ref`: `mission:<MISSION_ID>`
   - `proposed_memory_kind`: `'heuristic'` or `'sop'` or `'risk_rule'` as appropriate
   - `sensitivity_tier`: match the mission tier
   - `evidence_refs`: include `active/missions/<TIER>/<MISSION_ID>/MEMORY.md`
3. **Run the distillation pipeline** to flush promoted candidates into `knowledge/`:
   ```
   pnpm pipeline --input pipelines/fragments/memory-distillation.json
   ```
   Output lands in `knowledge/product/governance/HINTS.md`.
4. **Update sidecar status**: set `status: "promoted"` and `promotion_candidate_id` on the MEMORY.md sidecar.
5. **Update `knowledge/_index.md`**: run `pnpm pipeline --input pipelines/volatile-index.json` to refresh the volatile index.

If the mission MEMORY.md has no promotable learnings, skip steps 2–4 and note it in the mission summary.

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
*Status: Mandated by AGENTS.md*
