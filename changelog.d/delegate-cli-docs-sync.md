---
category: Added
---

- Add `pnpm delegate` / `pnpm kyberion delegate` — an operator-facing CLI that hands a bounded task to a governed sub-agent through the existing delegation path (KD-05 capability profiles, depth policy, concurrency and wall-clock budgets, mission attribution), documented in `knowledge/product/orchestration/delegation-cli-playbook.md`.
- Add `pnpm check:docs-impact` — a deterministic check that maps changed paths to documented surfaces (`knowledge/product/governance/docs-impact-map.json`) and reports which docs were not updated, so documentation decisions travel with code commits.
- Wire a `docs-sync` delivery task into the `code-change-aidlc` and `code-refactoring-aidlc` mission templates: delivery now requires `evidence/docs-sync-report.md` with every finding closed by a doc update or a recorded reason.
