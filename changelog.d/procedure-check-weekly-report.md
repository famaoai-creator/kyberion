---
category: Added
---

- **Weekly procedure check report and how-to** — the weekly curation pipeline (`wisdom:curation_report`) now also writes the procedure success-check status (same view as `pnpm kyberion procedure golden status`) to `knowledge/personal/governance/PROCEDURE_CHECK_REPORT.md`, personal tier only and never into the public `CURATION_REPORT.md`; the pipeline log carries the attention count. The report is skipped, with a warning naming the next step, when the run's persona may not write the personal tier. New operator guide: `knowledge/product/orchestration/procedure-success-check-playbook.md` (+ `.ja.md`).
