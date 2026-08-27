---
title: takt Clean-Room Notes
kind: notes
scope: repository
authority: reference
tags: [takt, workflow, judge-route, facet, provider-routing, human-in-the-loop, orchestration]
last_updated: 2026-08-16
---

# takt Clean-Room Notes

Source repository reviewed: `nrslib/takt` (v0.59.1). This note records implementation ideas in original Kyberion wording only; no source or prose is copied. Adoption plan: `docs/developer/improvement-plans-archive/2026-08/TAKT_ADOPTION_PLAN_2026-08-16.ja.md` (TK-01〜12).

## High-value concepts to reuse

- Declarative rule tables per step: first match wins, evaluated in declaration order, and **no implicit fallback** — an unmatched verdict aborts the run rather than silently continuing.
- LLM judgment expressed as a routing condition (a structured verdict feeding a route table), separate from the performing agent and run under a dedicated judge persona.
- Loops as ordinary back-edges, bounded by a global step ceiling plus consecutive-repeat and cycle detectors, optionally overseen by a periodic AI loop monitor.
- Human input as a first-class step/rule attribute; non-interactive runs auto-deny instead of guessing.
- Prompt material split into typed facets — persona, policy, knowledge, instruction, output contract — each a small reusable document, resolved through layered lookup (project overrides shared overrides built-in) with a "purity" convention (persona carries no procedure, policy carries no output format).
- Per-step provider/model/permission declaration with a documented resolution ladder (env → escalation → step → routing table by step/tag/persona → workflow default → global), a three-level permission vocabulary mapped per provider, and a required-permission floor.
- Escalation ("promotion") after N failures and a rate-limit switch chain as declarative step-level attributes.
- Provider seam with explicit capability flags (structured output, native image input, per-provider runtime instructions) and a unified call-options object (cwd, session, model, allowed tools, permission mode, output schema, streaming callbacks, abort signal, images).
- Separation of perform / report / status-judgment phases on one session, with the report phase restricted to write-only tools and a declared output contract.
- Concurrent read-only companion reviewers that are advisory-only and cannot alter routing.
- Isolation pitfall: a CLI agent that follows the `gitdir:` pointer in a worktree's `.git` file escapes back into the parent repository; full clones (reference + dissociate) avoid this.
- Evaluation split: engine mechanics tested with a mock provider; facet _content_ quality measured with a separate prompt-eval harness.

## Kyberion fit

- `libs/core/graph-scheduler.ts` + `scripts/run_pipeline.ts` — judge-then-route op (`core:judge_route`), loop detectors, `max_iterations` omission lint (TK-01/02).
- `libs/core/approval-gate.ts` + `pipeline-run-journal.ts` — suspend/resume human gate (`core:await_decision`) (TK-03).
- `knowledge/product/roles/`, `libs/core/working-principles.ts`, `mission-context-pack.ts` — facet registry with tenant → product → managed-pack layering (TK-04/09).
- `libs/core/reasoning-backend.ts`, `provider-permission-profiles.ts`, `reasoning-route-policy.json` — step-level provider/model/permission/promotion and routing table (TK-05).
- `libs/core/reasoning-runtime-instructions.ts` + `scripts/generate_subagent_definitions.ts` — provider runtime-instructions hook and Claude/AGY generation ceremony (TK-06). Codex/Gemini provider state remains derived runtime state rather than an additional hand-maintained artifact.
- `libs/core/report-contract.ts` — post-perform report validation against registered contracts or product JSON Schemas (TK-07).
- `libs/core/facet-registry.ts` — approved managed plugin facet declarations are resolved after product facets (TK-09).
- `libs/core/src/trace.ts` — opt-in OTLP/HTTP projection while preserving stable JSONL Trace (TK-10).
- `scripts/eval_facets.ts` + `eval/facets/` — deterministic facet-content contract checks, separate from engine tests (TK-11).
- `libs/core/background-review-runner.ts` — already equivalent to advisory companion review; keep the "advice never changes routing" line.

## Not adopted

YAML workflow format, home-directory config layer, tmux/terminal provider, engine-level side-effect steps, clone-based isolation (Kyberion uses per-mission Git with a provider co-execution contract).
