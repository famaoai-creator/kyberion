---
category: Added
---

- **Golden-scenario verdicts for procedure runs** — promoting a service or browser recording now stores its golden scenario next to the catalog (`golden/<id>.v<version>.json`, linked via `golden_scenario_ref`), and `dispatchProcedure` judges `service:preset` and Playwright runs against it (`libs/core/knowledge/golden-scenario-verdict.ts`). Service runs pass only when each expected response value was actually non-empty; Playwright runs append a read-only final snapshot so the check sees the page after the last action. `pass` records a verified run with `evidence: golden` ("passed its success check"), `fail` records a `failed_check` problem, and missing evidence or weak-only conditions stay `inconclusive` and record nothing. In scenario evaluation the dispatch status reported 5 of 6 real failures as success; the golden verdict caught 4 with no false pass.
