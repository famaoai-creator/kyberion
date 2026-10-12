---
record_id: mem-MSN-SURFACE-JOURNEY-20261012-2026_10_12
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-SURFACE-JOURNEY-20261012-2026_10_12
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-12T13:58:34.050Z
source_branch: feat/surface-journey-clarity-20261012
source_commit: 0bd18c1916296df608552ac6e23df0e2ba32e9e0
---

# Keep surface scope and next-action guidance truthful

Cross-surface navigation must preserve a concrete authorized workspace or ask for an explicit choice; task guidance must describe actual readiness and delivered vocabulary.

## Applicability

- mission
- mission:MSN-SURFACE-JOURNEY-20261012

## Reusable Steps

1. Cross-surface navigation must preserve a concrete authorized workspace or ask for an explicit choice; task guidance must describe actual readiness and delivered vocabulary

## Expected Outcome

Applicability: user journeys crossing surfaces, aggregate workspace views, and approval-gated diagnostic screens.

1. Treat personal and system views as aggregate scopes, never as synthetic tenants. Preserve an authorized concrete tenant and hierarchy; otherwise retain the requested destination while asking the existing workspace selector for an explicit choice. Cancel, Escape and browser history must preserve the original scope.
2. Share the navigation contract between rail and command search. Queue only a bounded destination identifier while server-resolved navigation and identity load, revalidate against the current catalog, and distinguish loading from a settled failure. Target-side authorization remains mandatory.
3. Derive next-action copy from actual readiness, storage, running, held, failed and verified-result states. A local role label is not proof of approval identity. Explain missing prerequisites before showing technical details.
4. Test the vocabulary delivered to the browser, including dynamically selected keys. A permissive fake translation function can hide missing delivery keys. Rebuild and verify settled text with reload and Back/Forward in a real browser.
5. For offline knowledge workflows, reasoning-backend selection alone does not select the wisdom profile. Preflight both independent selectors and keep embedding/provider probes disabled; do not claim structural fallback is model-generated reasoning.

Outcome: scope transitions become explicit and recoverable, while unavailable work and security prerequisites remain truthful.

## Evidence

- active/missions/public/MSN-SURFACE-JOURNEY-20261012/evidence/implementation-report.md
- active/missions/public/MSN-SURFACE-JOURNEY-20261012/evidence/test-report.md
- active/missions/public/MSN-SURFACE-JOURNEY-20261012/evidence/distillation.md

## Artifacts
