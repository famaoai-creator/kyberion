---
record_id: mem-MSN-PLATFORM-FACTS-20261102-2026_11_02
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PLATFORM-FACTS-20261102-2026_11_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-02T16:27:37.590Z
source_branch: feat/platform-facts-20261102
source_commit: f21dc1322dd3b5c98f633db081ccb0c010adc842
---

# Centralize platform facts in a leaf layer and gate raw platform reads

OS-specific facts (command locators, venv layout, IPC kind, env vars, shells) were re-invented inline at ~900 sites because the OS abstraction covered only actions, not facts. A frozen platform-facts descriptor layer plus a boundary test now centralizes nouns while the driver layer keeps verbs.

## Applicability

- mission
- mission:MSN-PLATFORM-FACTS-20261102

## Reusable Steps

1. OS-specific facts (command locators, venv layout, IPC kind, env vars, shells) were re-invented inline at ~900 sites because the OS abstraction covered only actions, not facts
2. A frozen platform-facts descriptor layer plus a boundary test now centralizes nouns while the driver layer keeps verbs

## Expected Outcome

Rule: platform facts (command locators, executable suffixes, venv layout, home env vars, shells, IPC transport, filesystem/symlink/process/media semantics) live in a frozen descriptor module (libs/core/platform-facts.ts) reached via injectable getPlatformFacts(p); OS actions stay in the OSDriver layer. New code must not read process.platform/os.platform() directly — a boundary test holds an explicit shrinking allowlist. Platform predicates must resolve the platform at call time so tests can stub process.platform via defineProperty. Prefer declarative seam/provider matching against facts over inline platform branches; keep name-based platforms matching for genuinely OS-bound implementations.

## Evidence

- active/missions/public/MSN-PLATFORM-FACTS-20261102/evidence/implementation-report.md
- active/missions/public/MSN-PLATFORM-FACTS-20261102/evidence/design-spec.json
- active/missions/public/MSN-PLATFORM-FACTS-20261102/evidence/retrospective.md

## Artifacts
