---
record_id: mem-MSN-PPC-LOOPBACK-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PPC-LOOPBACK-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T09:09:21.742Z
source_branch: feat/ppc-loopback-20261018
source_commit: 12a723b5f5a69813b80fba4420e3d9947d9d5545
---

# Gated experience write-back + human-gate resume close the learning loop

Persist only verified auto_advance lessons to the experience library; resume halted sessions via verified-snapshot adoption.

## Applicability

- mission
- mission:MSN-PPC-LOOPBACK-20261018

## Reusable Steps

1. Persist only verified auto_advance lessons to the experience library; resume halted sessions via verified-snapshot adoption

## Expected Outcome

Two rules for a self-improving harness loop. (1) Emission is not persistence: sessions emit experience records on every landed adoption, but the library writes only records passing a quality gate (auto_advance winner, ok&&delivered, not probe_refused, no materialization_error, no base_drifted), deduplicated on cue+lesson, honoring the causal asOf horizon. (2) A human_gate halt is resumable only through verified bytes: the adopted candidate must have delivered with a staged_snapshot whose manifest re-verifies, the halted base must match its recorded post-probe manifest, and the resumed adoption is labeled resume:r<N>:<label> distinct from auto_advance.

## Evidence

- active/missions/public/MSN-PPC-LOOPBACK-20261018/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PPC-LOOPBACK-20261018/evidence/test-report.md
- active/missions/public/MSN-PPC-LOOPBACK-20261018/evidence/requirements-draft.json

## Artifacts
