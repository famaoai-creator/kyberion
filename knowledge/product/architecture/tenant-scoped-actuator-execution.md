---
title: Tenant-scoped knowledge and actuator execution
tags: [tenant, knowledge, actuator, browser, computer-use, design, multimedia]
last_updated: 2026-09-11
kind: playbook
scope: repository
authority: reference
phase: [alignment, execution, review]
role_affinity: [planner, implementer, designer, reviewer, knowledge_steward]
applies_to: [knowledge, browser, media, video-composition]
---

# Tenant-scoped knowledge and actuator execution

## Before execution

Resolve the canonical execution scope and inspect its provenance with `pnpm scope show --json`.
Use registered tenants, not customer stances, theme names, or document titles, as the tenant
identity. A public-tier task carrying a tenant label still has public-tier visibility.

Place reusable knowledge with `pnpm knowledge place` at the requested containment level.
Start with its dry-run output. Tenant-wide rules belong at the tenant root; project-specific
rules belong below the organization/project chain. Missing parents must be resolved before
placing deeper knowledge. Do not promote confidential material to common/public by copying it.
Use the existing governed promotion process.

## Select the execution path

| Work                         | Path                                                           | Verification                                                             |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Repeatable browser procedure | Reviewed recording/procedure and browser actuator              | Expected post-action DOM values and required observations                |
| Adaptive browser interaction | Observe, choose a supported ref action, execute, observe again | Request post-action refs/screenshots; retain blocked and approval states |
| Desktop-specific interaction | System computer interaction after readiness checks             | Required OS permissions and actual action result                         |
| Documents and presentations  | Semantic brief, named pattern, scoped theme, media actuator    | Content and rendered layout, not just file creation                      |
| Generated media              | Registered generation/voice capability                         | Completed job and valid artifact matching the brief                      |
| Composed video               | Compile, prepare, await, verify                                | Video/audio streams plus visual/content review                           |

Keep the brief (intent), theme (visual identity), and pattern (structure) separate.
Use `resolveCreativeDesign` and engine design defaults rather than authoring per-element
style literals. Media confidential theme lookup uses the host's canonical confidential tenant
scope; naming a theme does not grant access. Personal themes are only available in personal
scope, with tenant-scoped personal execution restricted to its own lane.

`currentScope()` is cached for a CLI/runtime session. Hosts must establish the correct scope
before execution; do not repurpose one process for another tenant by changing only a theme
name or an action payload. Scope switching belongs to the governed host lifecycle.

For computer interaction, request the observations needed after the action. The pre-action
snapshot used to resolve a ref is not evidence that the action reached its intended result.
Successful execution, artifact generation, quality verification, and publication approval are
distinct outcomes.

## Limits and follow-up

Do not assume shared browser session IDs, explicit profiles, or CDP connections are isolated
merely because a task has a tenant label. Their ownership across all execution paths remains
an audit item. Video stream existence does not prove timing, readable subtitles, or editorial
quality. See the evidence and remaining work in
[the concept review and improvement plan](../../../docs/developer/improvement-plans-2026-08/TENANT_KNOWLEDGE_ACTUATOR_REVIEW_2026-09-11.ja.md).
