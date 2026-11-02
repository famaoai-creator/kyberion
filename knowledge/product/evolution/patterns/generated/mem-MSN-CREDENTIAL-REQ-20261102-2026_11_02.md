---
record_id: mem-MSN-CREDENTIAL-REQ-20261102-2026_11_02
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CREDENTIAL-REQ-20261102-2026_11_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-02T16:23:24.058Z
source_branch: feat/credential-req-20261102
source_commit: 5b99f320b835cd2402cd7ef00d674d7ea67d82cc
---

# Declare verb credential requirements; mint lineage-only bindings after claim

A persisted tenant scope without a WorkItem claim dead-ended every non-exempt verb at reasoning bootstrap, because the gate keyed on tenant presence rather than credential need — and fresh tenants had no bindTask resolver, so even dispatch could not mint a binding.

## Applicability

- mission
- mission:MSN-CREDENTIAL-REQ-20261102

## Reusable Steps

1. A persisted tenant scope without a WorkItem claim dead-ended every non-exempt verb at reasoning bootstrap, because the gate keyed on tenant presence rather than credential need — and fresh tenants had no bindTask resolver, so even dispatch could not mint a binding

## Expected Outcome

Rule: the bootstrap gate must key on declared verb credential requirements (none|degrading|required), not on tenant-scope presence. none verbs skip bootstrap; degrading verbs run on the stub chain unbound; unclassified verbs default required (fail-safe). Inside claimed-WorkItem dispatch, mint a lineage-only binding (empty secrets) when no resolver produces one — it attests task lineage while granting zero credentials; point-of-use checks remain fail-closed. Prefer a declared requirement registry over per-verb exemption lists.

## Evidence

- active/missions/public/MSN-CREDENTIAL-REQ-20261102/evidence/implementation-report.md
- active/missions/public/MSN-CREDENTIAL-REQ-20261102/evidence/design-spec.json
- active/missions/public/MSN-CREDENTIAL-REQ-20261102/evidence/test-report.md

## Artifacts
