---
record_id: mem-MSN-DISCUSSION-READINESS-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DISCUSSION-READINESS-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T19:25:33.862Z
source_branch: fix/discussion-readiness-20261018
source_commit: 78210ef141f9b93fdefde589dc1267fc62fd09bc
---

# Keep prerequisite inspection non-generating and uncertainty explicit

Before a real provider attempt, inspect only existing scope, policy, adapter and storage metadata; preserve unknowns, reserve execution only on explicit launch, and never turn a read-check retry into a generation retry.

## Applicability

- mission
- mission:MSN-DISCUSSION-READINESS-20261018

## Reusable Steps

1. Before a real provider attempt, inspect only existing scope, policy, adapter and storage metadata; preserve unknowns, reserve execution only on explicit launch, and never turn a read-check retry into a generation retry

## Expected Outcome

## Reusable rule

A prerequisite check must not construct an execution session when construction reserves a durable no-replay claim. Share narrow inspection logic with the launch path, and recheck known blockers before creating a room or starting an engine. Inspection may retain ordinary governed read/denial audits, but must not create credentials, permission grants, provider calls or test artifacts.

Keep each finding checked, blocked or unverified. Do not turn local metadata into a global execution-ready promise. Require server-resolved authentication and tenant/organization/project scope. A linked mission supplies its canonical context; client selections may only narrow visibility, never relabel the mission. Public text pasted into a confidential browser room does not downgrade that room or waive existing zero-retention and egress requirements.

## Inspect the actual transport

Use the selected adapter's declaration and its actual supported executable-resolution path. A different PATH CLI is not evidence for an SDK-selected binary. A bare or relative executable override cannot safely be tested against an unrelated repository working directory. Distinguish a confirmed missing file from an unavailable or denied inspection.

An existing executable file does not prove execution permission, loader compatibility, a tested CLI version, login or reachability. A governed ordinary directory or nearest existing parent does not prove runtime writability. Leave those results explicitly unverified rather than creating a sentinel or probing a provider to manufacture certainty.

## Preserve interaction and mutation boundaries

Bind reports to the selected provider and mission. Reject malformed or contradictory reports; invalidate stale responses, canceled requests and prior results after failed creation. Bound a read-only check with a deadline and clean up its timer. Deduplicate in-flight checks and repeated submission clicks while keeping launch a separate explicit action.

Retry check repeats only the non-generating inspection. A lost create POST response does not prove that no room or provider attempt started. Direct the operator to inspect existing rooms before explicitly considering another generation. Do not imply idempotency, durable replay recovery or permission to reuse an interrupted room's execution claim.

## What counts as execution evidence

This change was validated with builds, typechecks, mocked HTTP/unit/SSR tests, boundary tests and repository gates. It did not validate a rendered browser, provider login, network reachability or runtime writes. A previous Codex EROFS startup failure remains unresolved.

A separately authorized live acceptance run needs the intended environment and exact approved input scope, a bounded real transport attempt, a useful nonempty result, and saved room-bound artifacts verified by readback and digest. A configured provider, a selected adapter, scripted output or an in-memory preview is insufficient. Retain partial-save and uncertain-response failures honestly, and keep exact model identity unknown unless independently evidenced.

## Evidence

- active/missions/public/MSN-DISCUSSION-READINESS-20261018/evidence/design-spec.json
- active/missions/public/MSN-DISCUSSION-READINESS-20261018/evidence/integrated-validation.md
- active/missions/public/MSN-DISCUSSION-READINESS-20261018/evidence/live-flow-acceptance.md
- active/missions/public/MSN-DISCUSSION-READINESS-20261018/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DISCUSSION-READINESS-20261018/evidence/REVIEW-contract_authoring-ux-contract.md
- active/missions/public/MSN-DISCUSSION-READINESS-20261018/evidence/test-report.md

## Artifacts
