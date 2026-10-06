---
record_id: mem-MSN-ONBOARDING-RECOVERY-20261005-2026_10_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ONBOARDING-RECOVERY-20261005-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T01:04:19.279Z
source_branch: feat/onboarding-safe-first-job-recovered
source_commit: 12e4c5e5379ec48079e5bae9d2a2a127ed0ada83
---

# Bounded first-job authority and verifiable recovery evidence

Separate profile, configuration and human-approval readiness. Preserve diagnostic provenance through restart, validate authorization at the effect boundary, and keep evidence claims narrower than the available tests.

## Applicability

- mission
- mission:MSN-ONBOARDING-RECOVERY-20261005

## Reusable Steps

1. Separate profile, configuration and human-approval readiness
2. Preserve diagnostic provenance through restart, validate authorization at the effect boundary, and keep evidence claims narrower than the available tests

## Expected Outcome

## Applicability

Use when introducing a local, public-only first-job flow on top of a general execution engine.

## Pattern

1. Present saved profile, explicit execution configuration, and authenticated-human approval as separate readiness states. A read-only preview must not silently provision an identity or grant.
2. Bind each request, revision, decision and outcome to one exact viewer/tenant scope, pipeline bytes/version, charter and displayed effect. Persist diagnostic provenance with the admitted work; removing a current mode marker must not downgrade earlier work to a generic path.
3. Verify the actual browser session and current member authority. Bind purpose-separated proof to the exact effect and recheck live expiry, supported membership, signing-key, request and configuration revocations at settlement and immediately before the local effect and publication. Signing out is not claimed to revoke an already recorded approval. Operator locality and an asserted chat approval are not authenticated-human evidence.
4. A local-only execution guarantee must cover telemetry and extension callbacks as well as the primary operation. Keep local accounting and fail closed on unsupported observers rather than silently dropping a mandatory control.
5. Test the real governed setup facade and the actual runtime authority context. Exercise fresh-process request and revision restart, expired/revoked proof, and changed configuration. Synthetic session fixtures establish a source contract, not successful real-user sign-in or visual acceptance.
6. Preserve recoverable source checkpoints separately from runtime identity and approval state. After source loss, label recovered versus reconstructed material and verify the new tree afresh. Bind published lessons to the actual remote source commit, not a guessed or historical hash.
7. Offline behavior is workflow-specific. For canonical wisdom distillation, use KYBERION_WISDOM_LLM_PROFILE=stub and inspect the resolved candidates; a generic reasoning-backend stub does not necessarily constrain adaptive wisdom routing. An unavailable stub selects structural fallback and supplies no provider consistency verdict.

## Evidence and limits

Report full-suite failures separately from focused successes. Distinguish an observed permission error from a hypothesized cause of a timeout. Do not claim a provider consistency verdict when its CLI failed to initialize.

A receipt metadata panel is not file-content delivery. Held work needs an explicit safe recovery path; do not silently reset or recycle approval. Session-key proof is not an independent defense against an actor that compromises the server or can read its signing keys.

## Evidence

- active/missions/public/MSN-ONBOARDING-RECOVERY-20261005/evidence/implementation-report.md
- active/missions/public/MSN-ONBOARDING-RECOVERY-20261005/evidence/test-report.md
- active/missions/public/MSN-ONBOARDING-RECOVERY-20261005/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-ONBOARDING-RECOVERY-20261005/evidence/ux-contract.json

## Artifacts
