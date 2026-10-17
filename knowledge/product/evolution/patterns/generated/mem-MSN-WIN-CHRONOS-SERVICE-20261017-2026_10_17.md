---
record_id: mem-MSN-WIN-CHRONOS-SERVICE-20261017-2026_10_17
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-WIN-CHRONOS-SERVICE-20261017-2026_10_17
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-17T12:26:16.714Z
source_branch: feat/windows-multimodal-chronos-20261017
source_commit: 06cddb457a9f64786ec8281b2429f42b6f41a78a
---

# Plan Windows daemon lifecycle through Task Scheduler

Use a pure Windows Task Scheduler planner for per-user daemon installation and lifecycle commands. Keep plans deterministic and apply only through the guarded CLI.

## Applicability

- mission
- mission:MSN-WIN-CHRONOS-SERVICE-20261017

## Reusable Steps

1. Use a pure Windows Task Scheduler planner for per-user daemon installation and lifecycle commands
2. Keep plans deterministic and apply only through the guarded CLI

## Expected Outcome

## Pattern

Resolve Windows daemon management to Task Scheduler while preserving the shared service-manager interface. Generate task XML and encoded PowerShell commands as pure plans, and let the guarded CLI apply them. Register tasks for the interactive current user at logon with least privilege. Map start, stop, restart, status, and uninstall to explicit scheduler actions. Use restart-on-exit for resident daemons and repetition triggers for periodic one-shot jobs.

## Validation

Test rendered task plans and lifecycle mappings without registering tasks on the host. Escape XML values and encode PowerShell scripts before passing them to the scheduler.

## Evidence

Implementation and review evidence are in the MSN-WIN-CHRONOS-SERVICE-20261017 mission.

## Evidence

- active/missions/public/MSN-WIN-CHRONOS-SERVICE-20261017/evidence/implementation-report.md
- active/missions/public/MSN-WIN-CHRONOS-SERVICE-20261017/evidence/test-report.md
- active/missions/public/MSN-WIN-CHRONOS-SERVICE-20261017/evidence/REVIEW-execution-implement.md

## Artifacts
