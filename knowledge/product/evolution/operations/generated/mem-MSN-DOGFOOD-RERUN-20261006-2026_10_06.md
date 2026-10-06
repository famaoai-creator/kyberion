---
record_id: mem-MSN-DOGFOOD-RERUN-20261006-2026_10_06
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DOGFOOD-RERUN-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T13:14:37.208Z
source_branch: main
source_commit: 17529cb2a131466b81a5293c09d011a52fa490a2
---

# Archived missions orphan organization run evidence_refs; shared-scope orgs need sovereign writes

operation run record accepts active/missions/... evidence paths, but mission finish archives the directory — reconcile then reports invalid_evidence_refs from historical runs forever. Prefer durable refs (promoted knowledge paths) at record time. Separately, MISSION_ROLE=organization_operator does not cover public/shared-scope orgs; KYBERION_PERSONA=sovereign is required there.

## Procedure Steps

1. Rerun MSN-DOGFOOD-RERUN-20261006 confirmed: after MSN-DOGFOOD-FLOW-20261006 archived, its run record evidence_ref (active/missions/public/.../ops-report.md) turned into invalid_evidence_refs in reconcile, flagged once per store; recording a new run healed operation-state.json but historical runs/*/run.json refs stay orphaned. Workaround: cite durable paths (e.g. knowledge/product/evolution/...) in --evidence-ref. Authority: MISSION_ROLE=organization_operator + KYBERION_TENANT=shared was denied on the public/shared-scope org (persona worker unauthorized); sovereign succeeded — shared-scope orgs have no own-tenant operator path.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-DOGFOOD-RERUN-20261006/evidence/ops-report.md
- active/missions/public/MSN-DOGFOOD-RERUN-20261006/evidence/operation-run-receipt.md

## Artifacts
