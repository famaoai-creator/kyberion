---
title: 'Append-only JSONL store lifecycle: rotate, compact, archive'
tags: [governance, storage, retention, append-only, jsonl, janitor]
last_updated: 2026-10-16
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

## Which action for a new store?

1. **Does a reader need the full history?** If the file is event-sourced state that
   gets replayed (`dot-wake-ledger.jsonl`, `dot-inbox.jsonl`, `dot-action-ledger.jsonl`),
   truncation re-keys or re-fires consumed rows — keep it `review_required` and make
   the writer self-bounding, or accept bounded growth. See the catalog `note` fields:
   they name the constraint explicitly.
2. **Is the latest record per key enough?** → `compact` with `compact_key`
   (e.g. `item_id`, `lease_id`).
3. **Is it a pure log nobody replays?** → `rotate`.
4. **Never embed unbounded history in a versioned record.** `WorkItem.attempts` is
   capped at `MAX_RETAINED_ITEM_ATTEMPTS` (10) at write time because each version
   used to carry the full attempt list (~240 KB lines); the complete history belongs
   in the event feed (`observability/work-coordination/events.jsonl`), not in the
   state store.

## Reader contract

`readJsonLines` reparses the whole file each call — fine only while the store is
small. Hot or long-lived readers must use `readJsonLinesCached` / `JsonlTail`
(`libs/core/jsonl-tail.ts`), which reads only bytes appended since the cursor and
detects rotation/truncation (size regression, inode change, fingerprint). After a
`rotate` the next tail pass replays the new file from offset 0 — treat that as a
replay signal, not corruption.

## Gate

- `scripts/check_runtime_store_retention.ts` fails when source introduces an
  undeclared `active/shared/runtime/<name>` store.
- The janitor report surfaces `uncoveredRuntimeFiles` for top-level ledgers with no
  entry; rotated segments of a declared store are covered by their stem and never
  reported.
- A `compact` entry without `compact_key` fails catalog validation and falls back to
  built-in defaults with a warning — the store is then neither compacted nor
  silently deleted.
