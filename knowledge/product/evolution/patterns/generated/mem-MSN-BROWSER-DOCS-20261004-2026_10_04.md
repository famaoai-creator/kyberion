---
record_id: mem-MSN-BROWSER-DOCS-20261004-2026_10_04
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-BROWSER-DOCS-20261004-2026_10_04
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-04T18:22:48.745Z
source_branch: docs/browser-procedure-20261004
source_commit: be523751af74fbc660db90fe0918601f6b7185d4
---

# Separate browser execution status from verified outcomes

Browser reliability guidance needs one authoritative operational checklist. Transport status, observed business outcome, and authority to retry are separate questions, especially after timeouts or interrupted replay.

## Applicability

- mission
- mission:MSN-BROWSER-DOCS-20261004

## Reusable Steps

1. Browser reliability guidance needs one authoritative operational checklist
2. Transport status, observed business outcome, and authority to retry are separate questions, especially after timeouts or interrupted replay

## Expected Outcome

# Separate browser execution status from verified outcomes

## Reusable lesson

Keep one operator checklist for success postconditions, fresh unique targets, approval boundaries, bounded state waits, reconciliation, and redacted continuation records. Link discovery and replay guides to it rather than maintaining competing rules.

A timeout after dispatch leaves the remote effect unknown until readback establishes it. Repeating a real side-effecting workflow is not a safe reproducibility test; prefer authorized read-only, sandbox, or resettable inputs. Account for both per-operation and enclosing retry layers.

Treat not_started/success/failure/unknown as operator certainty labels, separately from the implemented completed/blocked/failed/cancelled receipt enum. Document requirements and future goals without presenting them as automatic runtime behavior.

Examples must match actual parameter placement and semantics. The reviewed browser pipeline supports selector/state/timeout waits and max_retries:0; generic computer-interaction wait remains duration-based. open_tab.params.keep_alive is not a supported retention control.

## Source-backed procedure

- [Canonical operating checklist](https://github.com/famaoai-creator/kyberion/blob/be523751af74fbc660db90fe0918601f6b7185d4/knowledge/product/orchestration/browser-automation-best-practices.md)
- [Safe site learning and replay](https://github.com/famaoai-creator/kyberion/blob/be523751af74fbc660db90fe0918601f6b7185d4/knowledge/product/orchestration/browser-site-learning-playbook.md)
- [Supported inspection example](https://github.com/famaoai-creator/kyberion/blob/be523751af74fbc660db90fe0918601f6b7185d4/knowledge/product/orchestration/browser-discovery-playbook.md)

Independent source review checked the parameter claims and examples. This lesson adds no runtime, schema, permission, or automatic resumption mechanism.

## Evidence

- active/missions/public/MSN-BROWSER-DOCS-20261004/evidence/implementation-report.md
- active/missions/public/MSN-BROWSER-DOCS-20261004/evidence/test-report.md
- active/missions/public/MSN-BROWSER-DOCS-20261004/evidence/REVIEW-execution-implement.md

## Artifacts
