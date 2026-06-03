---
title: "Retrofitting hand-written artifacts with dog-food pipeline evidence"
category: Evolution
tags: ["mission-retrofit", "dog-food", "hypothesis-tree", "shell-claude-cli", "wisdom-pipeline", "jgb-canton"]
importance: 6
source_mission: MSN-JGB-RETROFIT-20260422
author: Kyberion Wisdom Distiller
last_updated: 2026-04-22
---

# Retrofitting hand-written artifacts with dog-food pipeline evidence

## Summary
Retrofitted a pre-existing hand-written JGB canton tokenization artifact by regenerating the same analysis through the governed wisdom pipeline, producing real divergent-thinking output (9 hypotheses, 6 critiques) via the shell-claude-cli reasoning backend to satisfy the dog-food rule.

## Key Learnings
- Dog-food rule (AGENTS.md Rule 7) is retroactive: shipped artifacts selling Kyberion governance as the differentiator must be regenerated via mission/pipeline even when the hand-written version already exists — otherwise the 'Kyberion-backed audit trail' claim is a contradiction.
- Direct wisdom-actuator invocation produces stub output without full pipeline wiring; only running the end-to-end pipeline with a non-stub reasoning backend (shell-claude-cli or anthropic) yields genuine divergent thinking suitable as evidence.
- A cold retrofit-comparison document (pipeline output vs hand-written baseline) is the correct evidence format — it makes the delta between ungoverned and governed production auditable rather than hiding the retrofit.

## Patterns Discovered
- Three-checkpoint retrofit cadence: (1) exec hypothesis-tree to expose wiring gaps, (2) author cold comparison doc between hand-written and pipeline output, (3) regenerate with real backend once wiring is complete — each checkpoint is independently reviewable.
- shell-claude-cli backend unlocks dog-food compliance without requiring ANTHROPIC_API_KEY, making governed pipeline runs feasible in any environment with an authenticated local claude CLI.

## Failures & Recoveries
- First hypothesis-tree execution produced stub-only output because full pipeline wiring was incomplete → recovered by completing pipeline wiring and re-running with shell-claude-cli backend to produce real 9-hypothesis / 6-critique divergent output.

## Reusable Artifacts
- retrofit-comparison.md pattern — cold pipeline-vs-handwritten delta document
- pipeline-regeneration checkpoint output — 9 hypotheses + 6 critiques via shell-claude-cli as a reference dog-food evidence bundle

---
*Distilled by Kyberion | Mission: MSN-JGB-RETROFIT-20260422 | 2026-04-22*
