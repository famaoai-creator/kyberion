---
record_id: mem-MSN-PEER-TASK-EXCHANGE-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PEER-TASK-EXCHANGE-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T14:02:40.111Z
source_branch: feat/peer-task-exchange-20261018
source_commit: 702c77cf0830f37723bb1da853c9dd297586fb39
---

# Cross-runtime execution requests: name a type, let the recipient decide, test live

Lessons from adding typed peer tasks between Kyberion runtimes (propose, recipient-local accept, WorkItem execution, artifact references back), from running them live between two machines, and from fixing Japanese knowledge retrieval for peer auto replies.

## Applicability

- mission
- mission:MSN-PEER-TASK-EXCHANGE-20261018

## Reusable Steps

1. Lessons from adding typed peer tasks between Kyberion runtimes (propose, recipient-local accept, WorkItem execution, artifact references back), from running them live between two machines, and from fixing Japanese knowledge retrieval for peer auto replies

## Expected Outcome

- Let a remote peer only name a task type; the recipient's catalog fixes the executor (fixed pipeline or script with fixed args) and the allowed proposers, and the wire contract is strict so no peer text reaches argv, pipeline input or prompts.
- Keep transport receipt, recipient acceptance, execution and result delivery as distinct recorded states; receipt never executes. Return artifact references (path, sha256, size) and keep artifacts and raw output on the recipient unless the catalog opts in to an excerpt.
- Fence the pending -> decided transition and any resume with an inter-process lock, and record the runner (host, pid, deadline = start + timeout + grace). A dead parent pid alone does not prove the executor stopped: a non-detached child can outlive a killed parent, so require the deadline or an explicit --force.
- Refuse invalid proposals on receipt without writing ledger rows, cap pending per peer (ignoring expired rows) and bound peer-chosen timestamps; otherwise any secret holder can grow the ledger or park tasks forever.
- Record outbound requests before sending and resend with the same ids; a lost reply otherwise leaves a recipient-side task the proposer cannot correlate.
- Run new cross-machine flows live early from a plain operator shell: unit tests with injected runners and writers hid that the WorkItem tenant check needed the personal tenant profile, that tenant artifact-floor reads are tier-gated (a narrow tenant-bound role was needed), and that a test depended on the ambient KYBERION_TENANT.
- Lexical knowledge queries must segment spaceless scripts with the shared segmentWords (Intl.Segmenter), keep single kanji and fall back to the whole word; whitespace splitting turns a Japanese sentence into one token that matches nothing.
- The peer server verifies every envelope with one server-wide secret, so sender_peer_id (and any allowlist keyed by it) is self-asserted by secret holders; treat the operator's accept as the human check until per-sender secrets exist.

## Evidence

- active/missions/public/MSN-PEER-TASK-EXCHANGE-20261018/evidence/test-report.md
- active/missions/public/MSN-PEER-TASK-EXCHANGE-20261018/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PEER-TASK-EXCHANGE-20261018/evidence/implementation-report.md

## Artifacts
