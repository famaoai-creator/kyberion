---
record_id: mem-MSN-DISCUSSION-CREATE-RECOVERY-20261019-2026_10_19
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DISCUSSION-CREATE-RECOVERY-20261019-2026_10_19
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-19T03:54:48.447Z
source_branch: fix/discussion-create-recovery-20261019
source_commit: f13740ef5b1be0bdd7f333fdb1b4d73cd8bfc3b8
---

# Recover uncertain creates through scoped receipts without replay

Persist an exact scoped request handle before a non-idempotent create, reserve it exclusively on the server, and reconcile uncertainty through authenticated read-only evidence. A recovered room proves existence, not execution.

## Applicability

- mission
- mission:MSN-DISCUSSION-CREATE-RECOVERY-20261019

## Reusable Steps

1. Persist an exact scoped request handle before a non-idempotent create, reserve it exclusively on the server, and reconcile uncertainty through authenticated read-only evidence
2. A recovered room proves existence, not execution

## Expected Outcome

## When to apply

Use this pattern when a browser can lose a create response after the server may have started billable or otherwise non-repeatable work.

## Procedure

1. Resolve and authorize canonical tenant, organization, project, mission and tier before submission. Bind the authenticated actor and source, normalized intent and all cost-affecting configuration. Include absent optional scope fields in a canonical digest so later mission enrichment cannot redirect an unchanged request.
2. Persist only the opaque request UUID and original routing context before the first POST. Freeze the submitted input across preflight. If storage fails, do not submit. Preserve all unresolved handles across reloads, navigation and competing tabs; expose an explicit read-only check for each handle.
3. Use an exclusive durable reservation in the authenticated actor/source plus canonical-scope namespace. Never reclaim an uncertain reservation. Changed intent in that namespace conflicts; the same UUID in another canonical scope is a different namespace, not global deduplication.
4. Publish the immutable bound room-created event and verified terminal receipt before returning a launch flag. Only the original reservation winner may launch. Duplicate POSTs and every recovery branch must have no launch or repair path, even if no provider-start event exists.
5. Reauthorize the original scope before reading a receipt. Check its immutable binding and the original room-created event, rather than mutable title or room-list presence. Missing, torn, inaccessible or changed evidence remains unconfirmed. A strictly verified room-created event may recover the exact room read-only when its terminal receipt is absent.
6. Restrict the storage role with an exact deny-only capability for the two receipt files and required ancestors. Require a selected existing tenant. Read-only recovery receives no write or mkdir capability, and nested broader roles cannot escape the ceiling. Do not add shared-prefix exemptions or general confidential-data grants.
7. Bound HTTP waits through response-body parsing. A timeout or aborted wait does not cancel server or provider execution. Never automatically repeat POST after uncertainty. Clear only the matching pending handle after a proved created or rejected result.

## Validation and operational limits

Use separate processes to test the clean exclusive-publication race and require exactly one winner. Inject crashes after reservation, room publication and terminal receipt, then prove a new process can reconcile without launching. Test actor/source/scope/intent mismatch, absent-field scope drift, symlinks, missing policy, ambient role escape, GET write denial, browser storage failure and multiple unresolved handles.

Concurrent exclusive publication can change ancestor directory metadata during a secure read. If this is reproduced, retry only the exact ancestor-instability diagnostic within a small fixed bound, reauthorizing the whole snapshot each time and pinning the original leaf identity and metadata. Disappearance after observation, leaf replacement, policy failure, corruption and all writes or launches remain non-retriable.

A created result proves only exact room existence. It does not prove that a model ran or an artifact was saved. Permanent unresolved claims intentionally trade availability for non-replay. Do not claim global exactly-once semantics or full machine-power-loss durability from file fsync and process-restart tests. Real-provider and rendered-browser validation require separate evidence; mocked tests do not establish them.

## Evidence

- active/missions/public/MSN-DISCUSSION-CREATE-RECOVERY-20261019/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DISCUSSION-CREATE-RECOVERY-20261019/evidence/design-spec.json
- active/missions/public/MSN-DISCUSSION-CREATE-RECOVERY-20261019/evidence/implementation-report.md
- active/missions/public/MSN-DISCUSSION-CREATE-RECOVERY-20261019/evidence/test-report.md
- active/missions/public/MSN-DISCUSSION-CREATE-RECOVERY-20261019/evidence/distillation.md

## Artifacts
