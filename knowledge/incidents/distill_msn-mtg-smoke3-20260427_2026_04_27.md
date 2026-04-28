---
title: "Meeting facilitator end-to-end smoke: extract/self-execute/track all on LLM path"
category: Evolution
tags: ["meeting-facilitator", "smoke-test", "llm-pipeline", "action-items", "verification"]
importance: 4
source_mission: MSN-MTG-SMOKE3-20260427
author: Kyberion Wisdom Distiller
last_updated: 2026-04-27
---

# Meeting facilitator end-to-end smoke: extract/self-execute/track all on LLM path

## Summary
Smoke-tested the AI meeting facilitator pipeline end-to-end with a real LLM backend, confirming that extract, self-execute, and track stages all run on the LLM path and produce coherent outputs.

## Key Learnings
- A single smoke run that exercises every stage on the real LLM backend (not stub) is the cheapest signal that the facilitator pipeline is wired correctly — counts of AI/self/reminder items per stage are sufficient to detect regressions.
- Routing self-executable items vs. AI-actionable items vs. human-reminder items at extract time means downstream stages can be measured by simple cardinality checks (7 AI / 2 self / 5 reminder here).

## Patterns Discovered
- Smoke verification by stage-cardinality: record (AI-count, self-count, reminder-count) per run as a fingerprint; deviations flag pipeline drift without needing semantic diffing.

## Reusable Artifacts
- Mission micro-repo branch mission/msn-mtg-smoke3-20260427 as a reference smoke baseline (7 AI / 2 self / 5 reminder)

---
*Distilled by Kyberion | Mission: MSN-MTG-SMOKE3-20260427 | 2026-04-27*
