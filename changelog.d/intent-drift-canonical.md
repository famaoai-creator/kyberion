---
category: Fixed
---

- **Intent-drift gate no longer manufactures blocks on unchanged intent** — worker stage transitions and checkpoints previously recorded activity text ("auto-checkpoint…", "Mission X reconciling outcomes") as snapshot goals, LLM-extracted origin intents diverged lexically from the canonical goal, and the gate compared the origin against the latest activity-log line. Snapshots now record the mission's canonical intent (`goal_summary`/`source_text` + outcome-contract fields) whenever it exists — LLM extraction is a fallback only — and `evaluateIntentDriftGate` compares the origin against the canonical current intent. Missions created before this fix that already carry a noisy origin still need `pnpm mission triage` + `scope-approve` to rebaseline.
