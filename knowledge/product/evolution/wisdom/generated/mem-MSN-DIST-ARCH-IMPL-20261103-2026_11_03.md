---
record_id: mem-MSN-DIST-ARCH-IMPL-20261103-2026_11_03
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DIST-ARCH-IMPL-20261103-2026_11_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-03T19:46:24.455Z
source_branch: feat/dist-arch-storage-backend
source_commit: 6d063f7340565ef5fa1faa2ee28148d71fe18817
---

# Storage persistence goes through the storage-backend seam

Entry-ledger and future state consumers take a StorageBackend; inject createMemoryStorageBackend() for hermetic tests. Do not add parallel IO abstractions — FoundationIo covers JSON helpers, the seam covers governed selection.

## Hint Scope

mission

## Trigger Phrases

- # Storage persistence goes through the storage-backend seam

libs/core/storage/storage-backend.ts defines the sync POSIX-subset contract (exists/stat/mkdir/append/readLines/list) on a named provider-registry seam. The governed default is local-fs (delegates to secure-io, preserving tier/tenant/symlink/audit checks); memory is registered but never in default_chains — opt-in only.

Usage: createEntryLedger(path, { backend }) for injection; resolveStorageBackend(id?) for explicit selection; tests should use createMemoryStorageBackend() instead of mocking fs.

Rule: extend StorageBackend for new stores; do not add parallel IO abstractions. FoundationIo (foundation/io.ts) is the lower JSON-helper indirection; the seam is the governed, per-call-injectable layer above it.

## Recommended References

- active/missions/public/MSN-DIST-ARCH-IMPL-20261103/evidence/design-spec.json
- active/missions/public/MSN-DIST-ARCH-IMPL-20261103/evidence/implementation-report.md

## Evidence

- active/missions/public/MSN-DIST-ARCH-IMPL-20261103/evidence/design-spec.json
- active/missions/public/MSN-DIST-ARCH-IMPL-20261103/evidence/implementation-report.md

## Artifacts
