# TASK_BOARD: Ecosystem Vital Monitor (M-VITAL-MONITOR-001)

## Vision Context
- Tenant: default
- Vision: /vision/_default.md (Logic first, Vision for tie-breaking)

## Status: Completed (Implementation Phase)

- [x] **Step 1: Core Metrics Extension**
  - [x] Added `totalCostUSD` and `interventions` tracking to `MetricsCollector`.
  - [x] Implemented `COST_TABLE` for major models (GPT-4o, Gemini, Claude).
  - [x] Added `recordIntervention` for standalone human decision tracking.
- [x] **Step 2: Collect Physical Evidence**
  - [x] Updated `libs/core/skill-wrapper.ts` to capture `usage`, `model`, and `intervention` flags.
  - [x] Integrated `vision-judge.ts` to automatically record human decisions in metrics.
- [x] **Step 3: Vital Reporting Tool**
  - [x] Created `scripts/vital_report.ts` which aggregates physical evidence from `.jsonl`.
  - [x] Implemented "Sovereign Autonomy Score" calculation.
- [x] **Step 4: Validation**
  - [x] Verified via `scripts/simulate_vitals.ts` that costs are calculated accurately and interventions are recorded.

## Victory Conditions
- [x] Ecosystem health is measurable via physical evidence (logs/usage).
- [x] API costs are tracked in real-time ($0.0125 recorded in test).
- [x] Sovereign Autonomy Score (human intervention rate) is calculable.
