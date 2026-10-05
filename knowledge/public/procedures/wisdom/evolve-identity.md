---
title: 'Procedure: Identity Evolution & Wisdom Distillation'
last_updated: 2026-10-05
---

# Procedure: Identity Evolution & Wisdom Distillation

## 1. Goal

Extract latent wisdom from successful missions and manage identity patches to evolve the agent's persona.

## 2. Dependencies

- **Actuator**: `wisdom-actuator` (`history_search`, `knowledge_search`, `distill`, `inject_prior_knowledge`, `knowledge_export`, `knowledge_import`)
- **CLI**: `pnpm mission` (`distill`, `memory-queue`, `memory-review`, `memory-approve`, `memory-promote`)
- **Storage**: `knowledge/product/evolution/latent-wisdom/` (persona patch files, `patch-*.json`)

## 3. Step-by-Step Instructions

1.  **Audit**: Review completed-mission history for divergent behavior worth keeping. Use `wisdom-actuator` `history_search` (zero-LLM search over the public history index) or `knowledge_search` to locate candidate missions, and `pnpm mission memory-queue` to see unprocessed distillation output.
2.  **Distillation**: Run `pnpm mission distill <MISSION_ID>` on the finished mission. This produces the mission distillation and enqueues memory-promotion candidates (`libs/core/knowledge/distill-candidate-registry.ts`); curate them with `pnpm mission memory-review` → `memory-approve` → `memory-promote <candidate_id> --target-root <worktree>` (see `knowledge/product/governance/phases/review.md`).
    - For a lessons summary over recent distillations inside a pipeline, use the `distill` apply op (params: `scope`, `limit`) — the same op used by `pipelines/fragments/memory-distillation.json`.
    - Persona-relevant deltas are stored as a patch file under `knowledge/product/evolution/latent-wisdom/` (`patch-<mission>-<n>.json` with `id`, `source_mission`, `deviation_summary`, `delta_rules`, `evidence_path`).
3.  **Activation**: To run a session under a specific persona, pass the patch id to the Kyberion CLI via `--branch <patch-id>` — the patch is loaded from the latent-wisdom store and announced by the persona-swap banner at startup. To recall distilled lessons inside a mission instead, use `inject_prior_knowledge` (params: `topic`, `tags`, `limit`, `output_path`).
4.  **Tier Sync**: Move knowledge between `personal` / `confidential` / `public` tiers only through the governed transfer ops — `knowledge_export` (`path`, `visibility`) followed by `knowledge_import` (`package_path` or `source_path`, `tier`). Never copy files across tiers by hand; cross-tier flow is deny-unless-brokered and audited.

## 4. Expected Output

A version-controlled history of persona patches under `knowledge/product/evolution/latent-wisdom/` and promoted mission learnings that future dispatches can retrieve.
