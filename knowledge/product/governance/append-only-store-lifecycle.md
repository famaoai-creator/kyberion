---
title: 'Append-only JSONL store lifecycle: rotate, compact, window, archive'
tags: [governance, storage, retention, append-only, jsonl, janitor]
last_updated: 2026-11-02
---

# Append-only JSONL store lifecycle

Canonical rules for `.jsonl` stores that grow by appending records and are read back
as state. Motivation (MSN-LOG-STORE-HARDENING-20261016): the work-coordination
`items.jsonl` reached 31 MB — 853 versioned lines for 101 live items, single lines
up to 241 KB — and every `currentWorkItem()` call parsed the whole file. Directory
mtime TTL can never expire such files (appends keep mtime fresh), so they need a
different lifecycle contract.

## The three actions

Declare them in `storage-retention-catalog.json` on the **file path** itself
(entries ending in `.jsonl`; enforced by the schema and the loader).

| action    | when                                               | what the janitor does                                                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rotate`  | pure event/observability logs                      | renames the live file to `<stem>-YYYYMMDD-HHmmss.jsonl` once it exceeds `rotate_min_bytes` (default 8 MiB); writers reopen the canonical path, so appends continue. Segments age by mtime and expire via `ttl_days` + `segment_action` (`delete` default, `archive` for evidence), or a covering directory TTL when the file sits under one. |
| `compact` | versioned keyed state (latest record per key wins) | folds the file to the last record per `compact_key` once it exceeds `compact_min_bytes` (default 4 MiB); the pre-compaction file is copied to `active/archive/jsonl-compaction/<repo-rel>.<stamp>.jsonl` first, then the live file is atomically rewritten. Records lacking the key are kept verbatim. Order = last appearance.              |
| `archive` | compliance streams that must not be deleted        | expired files are moved to `active/archive/<repo-rel>` (the archive tree is `review_required`, so archived evidence is never auto-deleted). Always audited.                                                                                                                                                                                  |

Every mutation emits a `RETENTION_ROTATE` / `RETENTION_COMPACT` /
`RETENTION_ARCHIVE` record to `active/shared/logs/audit/storage-retention.jsonl`.

## Three principles (MSN-STORE-BOUNDS, 2026-11)

A five-megabyte read cap on `trigger-deliveries.jsonl` once crash-looped chronos for
two weeks. Size caps on runtime stores turn growth into an outage, so:

1. **Size never fails a read.** Choose the reader by what the caller needs, never by
   how big the file is today (see Reader contract).
2. **The store owns its retention, at write time.** The writer calls
   `maintainStoreAfterAppend(path, policy)` (`libs/core/append-only-store.ts`) right
   after appending. It is a cheap stat until the store crosses its threshold, then runs
   under the store lock, and re-runs only after the store doubles. The janitor uses the
   same implementation, but correctness never depends on the janitor running.
3. **Growth warns; it never fails an append.** Maintenance failures log a diagnostic
   warning and return `'failed'`; ops-health reports overgrowth.

Size caps stay only for untrusted input (uploads, attachments, external files).

## Write-time policies

| policy    | use when                                    | notes                                                                                                                                                                                                    |
| --------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rotate`  | pure logs nobody replays                    | readers that need history must scan segments too (`events.jsonl` + `events-<stamp>.jsonl`)                                                                                                               |
| `compact` | readers need only the latest record per key | `key` is a field name or a function for composite keys (`${dot_id}:${signal}`); a function returning undefined keeps the record verbatim — use that to protect rows a reader needs (work-item version 1) |
| `window`  | readers need only a time window             | explicit policy only (the catalog has no `window` action); `timeOf`, optional `keep`, optional `archiveDir` for evidence; keep a margin beyond the longest reader window                                 |

Dynamic paths (per tenant, session, namespace or env-overridden root) cannot match an
exact-path catalog entry, so their writers pass an explicit policy and the catalog
entry for the parent directory describes it in its `note`. A store whose only
retention is the writer's (the janitor must not touch the live file) is
`self_managed: true` (rotate/compact) or `review_required` with a note (window).

**Archives.** The writer of a store usually cannot write `active/archive/`. Write-time
archives go next to the store (`writeTimeArchiveDir(path)` gives
`<store dir>/compaction-archive/`, same tier and tenant) or under
`active/shared/observability/...`; either way the archive directory needs its own TTL
entry.

## Which policy for a new store?

1. **Does a reader need every record ever written?** Dedupe registries
   (`ingest/content-hash-registry.jsonl`), idempotency stores, hash chains
   (`active/audit/system-ledger.jsonl`, tenant ledgers — these rotate into chain-continuing segments, see below), line-position-keyed stores
   (`dot-inbox.jsonl`) — no window or rotation; stream the reader and state the
   reason in the catalog note.
2. **Is the latest record per key enough?** Use `compact`, after checking that no
   reader counts or compares older versions (KR `signal_ratio` reads 720h of dot
   signals, so the signal ledger uses a window instead).
3. **Is a time window enough?** Use `window` with a margin (dot feedback: 30d read,
   37d kept; token usage: today read, 3 days kept, so a daily cap can never be
   bypassed).
4. **Is it a pure log nobody replays?** Use `rotate`.
5. **A reducer whose state only grows** (agent-input-queue consumed ids) cannot be
   both bounded and identical; bound it by dropping whole finished pairs past a
   horizon and document the visible effect.
6. **Never embed unbounded history in a versioned record.** `WorkItem.attempts` is
   capped at `MAX_RETAINED_ITEM_ATTEMPTS` (10) at write time; the complete history
   belongs in the event feed, not in the state store.

## Hash-chained ledgers

`ledger.ts` rotates the system and tenant ledgers itself, under the ledger lock, once
the live file passes `LEDGER_SEGMENT_ROTATE_BYTES`: the live file becomes
`<stem>-YYYYMMDD-HHmmss[-n].jsonl`, and the new live file starts with a chained, signed
`LEDGER_SEGMENT_OPENED` entry naming the previous segment and its last hash. Verification
streams every segment, then live; findings name the segment
(`segment_boundary:<segment>:parent_hash_mismatch:after:<previous>`,
`segment_boundary:<segment>:marker_names:<name>`, `chain_start:<file>:parent_hash_mismatch`).
Archive segments oldest first only — removing one from the middle breaks verification —
and declare the live file `self_managed` so nothing else rotates it.

## Narrow store capabilities

A store written under an exact-path capability (e.g. tenant autonomy outcomes) cannot
stage a rewrite. Admit only that store's rewrite siblings with the scope's
`namePrefixExact` list (`<store>.compacting-`, `.compact-out-`, `.compact-restore-`,
`<dir>/compaction-archive/` one level deep; never mkdir beyond the declared archive dir);
take the store lock and write the retention audit outside the capability, under the
caller's identity. A writer that cannot write the retention audit log passes
`audit:` to route RETENTION_* records to the audit chain.

## Reader contract

Readers are in `libs/core/jsonl-read.ts`. None has a size cap, and each read stays on
one open file (inode) even if the store is rotated or compacted mid-read.

| need                | reader                                                |
| ------------------- | ----------------------------------------------------- |
| last record         | `readLastJsonLine` / `readJsonLinesBackward`          |
| recent window       | `readJsonLinesSince`                                  |
| full history / fold | `streamJsonLines` (constant memory, forward)          |
| line numbers        | `streamTextLines` (matches `split(/\r?\n/)` indexing) |

- Skip and count malformed lines (`onMalformed`) unless the store's contract is
  strict (work-coordination items/leases and agent-input-queue fail closed).
- After a torn tail, the next append must start on a new line
  (`fileEndsWithNewline`), or the new record merges into the broken one.
- While another process compacts, the live file is briefly parked; readers that must
  not see an empty store read the parked copy (`jsonl-parked-read.ts`).
- `JsonlTail` / `readJsonLinesCached` (`libs/core/jsonl-tail.ts`) read in chunks with
  no size cap; a large backlog warns once and the cursor still advances. Use them for
  hot incremental replay, not as a substitute for a window reader.

## Gate

- `runtime-store-whole-read` (`scripts/check_runtime_store_whole_read.ts`, ratchet
  baseline `scripts/check_runtime_store_whole_read.baseline.json`) fails when a file
  adds a whole-file read of a JSONL store (`readJsonLines`, `readJsonLinesCached`, or a
  read-then-split in a file naming `.jsonl`). Move the reader to `jsonl-read.ts`; when a
  count drops, lower the baseline with `--write-baseline`.
- ops-health `probeStoreOvergrowth` warns on catalogued stores past twice their
  threshold and on any `.jsonl` over 32 MiB inside a `review_required` runtime directory.
- ops-health `probeStaleCompactionCopies` warns on any `.compacting-*` copy older than an
  hour: a failed parked rewrite keeps it, parked-aware readers re-read it on every call
  and agent-input-queue compaction stays skipped until it is merged back with
  `pnpm kyberion storage recover-compaction-copies` (dry-run; approval-gated apply).
- `scripts/check_runtime_store_retention.ts` fails when source introduces an
  undeclared `active/shared/runtime/<name>` store.
- The janitor report surfaces `uncoveredRuntimeFiles` for top-level ledgers with no
  entry; rotated segments of a declared store are covered by their stem and never
  reported.
- A `compact` entry without `compact_key` fails catalog validation and falls back to
  built-in defaults with a warning — the store is then neither compacted nor
  silently deleted.
