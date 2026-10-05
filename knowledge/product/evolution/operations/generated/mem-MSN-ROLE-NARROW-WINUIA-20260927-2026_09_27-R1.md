---
record_id: mem-MSN-ROLE-NARROW-WINUIA-20260927-2026_09_27-R1
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ROLE-NARROW-WINUIA-20260927-2026_09_27-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:32:19.238Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Privilege narrowing needs trace + reachability double evidence; Windows UIA walker fallbacks

How to safely remove entries from role-assumption-policy, and how to build a Windows accessibility detector.

## Procedure Steps

1. Removing a may_assume entry from the role-assumption policy: collect a runtime trace (KYBERION_ROLE_ASSUMPTION_TRACE JSONL per withExecutionContext* decision) AND a static call-level reachability report (TypeScript compiler API reference graph from each surface entry point). Remove an entry only when the static report marks it unreachable AND no trace observed it; keep a checked-in report with a CI gate so drift is caught, and give every removed or added entry a rationale. Bias analysis to 'reachable': unresolved dynamic imports and SYSTEM_ROLE-inheriting child processes count as 'any role'. For Windows UI Automation detectors: run PowerShell -NoProfile with the script fed on stdin (never on the command line — quoting and length limits), enumerate the frontmost window only, and walk providers in order managed control view → COM UIA → Win32 class fallback, keeping the same caps/labels/editable semantics as the macOS AX path.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-ROLE-NARROW-WINUIA-20260927/evidence/design-spec.json
- active/missions/public/MSN-ROLE-NARROW-WINUIA-20260927/evidence/implementation-report.md
- active/missions/public/MSN-ROLE-NARROW-WINUIA-20260927/evidence/distillation.md

## Artifacts
