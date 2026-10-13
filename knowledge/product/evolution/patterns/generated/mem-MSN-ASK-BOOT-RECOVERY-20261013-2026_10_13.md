---
record_id: mem-MSN-ASK-BOOT-RECOVERY-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-ASK-BOOT-RECOVERY-20261013-2026_10_13
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-13T06:55:01.923Z
source_branch: fix/ask-boot-recovery-20261013
source_commit: f57d05738297df8ec948ae1204fad59dfe50590a
---

# Separate optional projections from prerequisite startup reads

Keep conversation readiness independent of optional recent-activity reads, preserve usable server-rendered labels through startup failures, and make read recovery explicit without replaying mutations.

## Applicability

- mission
- mission:MSN-ASK-BOOT-RECOVERY-20261013

## Reusable Steps

1. Keep conversation readiness independent of optional recent-activity reads, preserve usable server-rendered labels through startup failures, and make read recovery explicit without replaying mutations

## Expected Outcome

## Applicability
Use this pattern when a browser surface restores a primary conversation or work item while also loading an optional list, badge, or projection.

## Failure pattern
A shared Promise.all barrier makes an optional read rejection or delay block the primary workflow. Rendering with an empty or partial vocabulary can then erase the very labels needed for recovery. Extracting a helper also introduces a script-delivery dependency that needs its own fail-closed recovery state.

## Procedure
1. Classify prerequisites separately from optional projections. Preserve existing scope/authentication readiness before loading protected state; a manual retry must not bypass that prerequisite.
2. Start optional projections independently after their required presentation data is usable. Give each a loading, failed, validated-empty, and populated state. Do not label a failed or malformed response as empty.
3. Bound only the intended read requests. A settled timeout and generation token must discard late completions, including older reads that race a newer refresh. Keep retry clicks serialized. Do not add mutation retry, mutation cancellation, polling, or persistence as a side effect.
4. Keep server-rendered control labels until required nonblank vocabulary is verified. Check direct event-driven render paths, such as voice status callbacks, as well as the main render function. Use escaped fallback attributes and textContent where appropriate.
5. Preserve unsent input through in-page retries. If an extracted helper fails to load, leave execution disabled, show readable startup failure, and expose an explicit ordinary page reload; do not silently execute a fallback path.
6. Keep cohesive read-recovery logic below existing file-size limits by extraction, not by relaxing the gate. Load the helper before its consumer and test that delivery order. Use repository formatter settings and ensure source-derived contract tests cannot pass with zero discovered keys.

## Verification
Test rejection, delay, timeout, late success, repeated retry, malformed payloads, early typing, prerequisite failure, and missing helper delivery. Re-run the actual browser after changing a script boundary. Clearly distinguish real component behavior with synthetic read-only adapters from a live authenticated backend workflow; do not infer request counts from an unavailable diagnostic route.

## Result
The primary conversation remains available when optional reads fail, recovery stays understandable, and the original execution and authorization contracts remain intact.

## Evidence

- active/missions/public/MSN-ASK-BOOT-RECOVERY-20261013/evidence/implementation-report.md
- active/missions/public/MSN-ASK-BOOT-RECOVERY-20261013/evidence/test-report.md
- active/missions/public/MSN-ASK-BOOT-RECOVERY-20261013/evidence/browser-qa.md
- active/missions/public/MSN-ASK-BOOT-RECOVERY-20261013/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-ASK-BOOT-RECOVERY-20261013/evidence/distillation.md

## Artifacts
