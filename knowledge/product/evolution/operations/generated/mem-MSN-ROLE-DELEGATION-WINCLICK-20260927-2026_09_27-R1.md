---
record_id: mem-MSN-ROLE-DELEGATION-WINCLICK-20260927-2026_09_27-R1
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ROLE-DELEGATION-WINCLICK-20260927-2026_09_27-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:32:43.896Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Role delegation to child processes; DPI-aware Windows pointer injection

How to pass authority down a spawn tree safely, and how Windows clicks must match detector pixels.

## Procedure Steps

1. Delegating a role to a spawned child: always build the env with buildExecutionEnv(env, role) — it sets KYBERION_DELEGATED_ROLE=<role>@<issuing SYSTEM_ROLE>, bound to that SYSTEM_ROLE and validated with the same isRoleAssumptionAllowed as in-process assumptions; a denied delegation degrades to the worker persona, fail-closed. Never set MISSION_ROLE alone — an inherited SYSTEM_ROLE outranks it and the child silently runs as the parent surface. Strip authority env vars (SYSTEM_ROLE, KYBERION_DELEGATED_ROLE, personas) from caller/data env overlays; launches that set SYSTEM_ROLE themselves must use buildSystemRoleLaunchEnv so a stale delegation cannot rebind the surface. Windows pointer injection: make the script's thread per-monitor DPI aware (SetThreadDpiAwarenessContext, falling back to SetProcessDPIAware) and click in physical pixels to match the UIA/BoundingRectangle detector space; compile walker assemblies in memory — a disk cache is a code-injection risk.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-ROLE-DELEGATION-WINCLICK-20260927/evidence/design-spec.json
- active/missions/public/MSN-ROLE-DELEGATION-WINCLICK-20260927/evidence/implementation-report.md
- active/missions/public/MSN-ROLE-DELEGATION-WINCLICK-20260927/evidence/distillation.md

## Artifacts
