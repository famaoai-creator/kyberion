---
record_id: mem-MSN-RETIRE-TASK-PLAN-20261114-2026_11_14
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-RETIRE-TASK-PLAN-20261114-2026_11_14
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-14T05:35:30.235Z
source_branch: refactor/retire-execute-task-plan-20261114
source_commit: 44ca6b7edf0ccc3e87e5d663ad1c7c3b397aa178
---

# Confine an unclaimed delegation at spawn, per provider, or refuse it

A delegated agent runtime without a WorkItem claim must be confined to read-only when it is spawned, by a mechanism each provider adapter actually enforces; a provider that cannot be confined refuses the delegation instead of running with its own tools.

## Applicability

- mission
- mission:MSN-RETIRE-TASK-PLAN-20261114

## Reusable Steps

1. A delegated agent runtime without a WorkItem claim must be confined to read-only when it is spawned, by a mechanism each provider adapter actually enforces; a provider that cannot be confined refuses the delegation instead of running with its own tools

## Expected Outcome

When an agent execution port delegation carries no claimed WorkItem, the runtime gets no governed task tools, so its tool surface is whatever the provider adapter starts with. Retiring the only unclaimed writer (orchestrator:execute_task_plan) made it possible to require read-only for every such delegation.

Lessons:

- Approval is not availability. For Claude, a tool that is not approved can still be offered, and a subagent definition can carry write tools of its own. Limit availability (--tools to the read tools), deny write, shell and subagent tools explicitly, start no MCP server, and load no setting sources.
- Fail closed visibly. An adapter that returns an empty result on error makes the port report a refused run as succeeded and the audit chain record completed. Build the confinement at boot so the spawn fails, and throw when a confined turn errors.
- Check the runtime you ask. If the port ensures a runtime and then asks by id, verify the runtime registered under that id is still the confined one.
- Providers whose sandbox is fixed at construction must be confined at spawn time; any provider, backend or transport that cannot carry the read-only mode refuses.
- A replacement that rewrites a shared record (the mission board) must refuse to drop rows it did not write, or a retired op's callers silently lose work.
- Measure baselines from a fresh build; a stale dist gave a wrong export-surface count.

## Evidence

- active/missions/public/MSN-RETIRE-TASK-PLAN-20261114/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-RETIRE-TASK-PLAN-20261114/evidence/implementation-report.md
- active/missions/public/MSN-RETIRE-TASK-PLAN-20261114/evidence/retrospective.md

## Artifacts
