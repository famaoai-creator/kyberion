---
record_id: mem-MSN-LEGACY-CLEANUP-20261031-2026_10_31
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-LEGACY-CLEANUP-20261031-2026_10_31
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-31T14:26:12.154Z
source_branch: chore/legacy-cleanup-20261031
source_commit: fbc28dfc72f0aa2dadd20f75a8980a04254d0d06
---

# Verify a store's role before consolidating it, and never read from a TTL-swept location as a fallback

Two tool-runtime roots that looked duplicated had different jobs (install root vs download cache); a legacy read fallback into the per-file-swept cache floor could have run torn venvs.

## Applicability

- mission
- mission:MSN-LEGACY-CLEANUP-20261031

## Reusable Steps

1. Two tool-runtime roots that looked duplicated had different jobs (install root vs download cache); a legacy read fallback into the per-file-swept cache floor could have run torn venvs

## Expected Outcome

When a survey flags two storage locations as duplicates, list what each one actually holds (names and sizes only) before merging them. In MSN-LEGACY-CLEANUP-20261031, active/shared/runtime/tool-runtimes held every approved install (venvs, binaries, state.json) while active/shared/cache/system/tool-runtimes held only uv/pip/XDG/Hugging Face download caches; the real defect was that callers built the paths by hand. The fix was one resolver in libs/core/tool/tool-runtime-policy.ts, not a move.

Do not add a read fallback into a location that the storage janitor sweeps file by file. storage-janitor checks each file's mtime, and venv or model trees keep upstream mtimes, so a 30-day cache/system sweep leaves torn trees. A fallback that treats such a directory as installed (bin/ or state.json present) can override a working backend. The independent review blocked exactly this; the resolver now reads the canonical root only.

Trees whose files keep upstream mtimes (model snapshots, venvs) need a review_required retention entry or whole-directory eviction, plus a hermetic scanStorageFloors dry-run test proving the exemption.

## Evidence

- active/missions/public/MSN-LEGACY-CLEANUP-20261031/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-LEGACY-CLEANUP-20261031/evidence/design-spec.json
- active/missions/public/MSN-LEGACY-CLEANUP-20261031/evidence/implementation-report.md

## Artifacts
