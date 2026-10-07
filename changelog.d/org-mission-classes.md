---
category: Added
---

- **Organization mission classes** — `classify` now distinguishes five organization-function classes (`finance_and_accounting`, `people_and_talent`, `legal_and_compliance`, `strategy_and_governance`, `procurement_and_supply`) with their own team templates, review gates (`FINANCIAL_CONTROLS`, `PEOPLE_DATA_PROTECTION`, `LEGAL_REVIEW`, `VENDOR_INTEGRITY`, `ASSUMPTIONS_EXPLICIT`), class-level workflows, and seven new business intents (monthly close, budget review, fundraising, hiring, performance review, board prep, vendor procurement).
- **Per-class AI operating playbooks** — `mission-class-playbooks.json` defines, for all 14 classes, the autonomy posture, stage-by-stage practice and know-how, quality bar, pitfalls, and escalation triggers; missions carry it in `mission-workflow.json` (`class_playbook`) and the TASK_BOARD header.
- **Class evaluation corpus** — `mission-class-eval-corpus.json` + `mission-class-eval.ts` score the utterance → intent → class → workflow → team → gate chain (dev / holdout / false-positive splits) with CI floors. Baseline 10.3% overall / 0% holdout → 98.8% / 96.3%.
