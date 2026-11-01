---
record_id: mem-MSN-STORE-BOUNDS-20261101-2026_11_01
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-STORE-BOUNDS-20261101-2026_11_01
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-01T06:06:46.551Z
source_branch: feat/store-bounds-20261101
source_commit: 169268f1ad0fbb64bede200504dee7df2e0c3082
---

# A runtime store's size must never fail a read or an append: purpose-specific readers, write-time retention, self-managed stores

Pick JSONL readers by purpose (last line / backward window / stream) pinned to one inode, run retention at write time through the shared append-only-store helpers, mark history-bearing stores self_managed so the janitor never rotates them, and treat growth as a warning.

## Hint Scope

mission

## Trigger Phrases

- In MSN-STORE-BOUNDS-20261101 the size limits on runtime JSONL stores were redesigned after the trigger journal (MSN-OPS-HEALTH-20261101) crash-looped chronos by outgrowing a whole-file read cap. A survey found the same failure class across about 160 whole-file readers of growing stores (readJsonLines inherits the 100MB secure-io cap and throws), O(N) last-hash reads in ledger.ts, an audit chain that silently forked on an oversize day file, and janitor compaction that could not recover a store over 100MB.

Rules (these supersede the earlier "writes stop at a hard cap below the read window" rule):

- A runtime store's size must never make a read or an append fail. Choose the reader by purpose with libs/core/jsonl-read.ts: last record = readLastJsonLine, recent window = readJsonLinesBackward / readJsonLinesSince to a time cutoff, full history = streamJsonLines (constant memory). Size caps belong only on untrusted input (attachments, uploads).
- A chunked reader must be pinned to one inode for the whole scan (secure-io openSafeRangeReader); per-chunk path reads tear or truncate when inline rotation/compaction renames the file.
- Retention is owned by the store and runs at write time through libs/core/append-only-store.ts (rotate / compactStoreByKey / retainWindow / maintainStoreAfterAppend, which never throws and backs off by doubling, including after failures). The janitor uses the same code.
- Removing a cap changes who else acts on the store: a catalog `rotate` entry plus the janitor's 8MiB default would have rotated the uncapped trigger journal and dropped its dedupe window. A store whose correctness depends on history is marked `self_managed: true` in storage-retention-catalog.json — the janitor only expires its segments.
- Rotation of a history-bearing store moves only the dropped records to the segment (segment + live = old content), frees a size-proportional amount, records backoff in finally, and cleans orphaned temps under the lock — never re-copy the whole store on every attempt.
- Compaction passes must index exact byte lengths per pass and copy late bytes verbatim; keep staging copies only when data is not otherwise intact; fall back when hard links are unsupported.
- An audit/hash-chain writer that cannot read its tail must refuse before mutating its cursor, and seed its cursor from disk only — never fork silently from an older record and never drop a record silently.
- Growth is a warning (ops-health), not a fail-closed append.

## Recommended References

- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/design-spec.json
- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/implementation-report.md
- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/test-report.md

## Evidence

- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/design-spec.json
- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/implementation-report.md
- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-STORE-BOUNDS-20261101/evidence/test-report.md

## Artifacts
