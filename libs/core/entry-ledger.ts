/**
 * Shared append-only JSONL entry-ledger mechanics.
 *
 * One concept — an append-only ledger of schema-validated entries — used to
 * be rebuilt per domain (ingest asset ledger, inboxes, promotion queues,
 * provenance ledgers). This factory owns the mechanics that are always the
 * same: ensure the parent directory, reject non-regular files, append one
 * validated line, and read lines back tolerating corrupt rows.
 *
 * Domain semantics stay outside: validation rules, dedupe keys, state
 * transitions, tenant isolation and compaction policy are caller concerns.
 *
 * Persistence goes through the `storage-backend` seam: callers may inject a
 * `StorageBackend` (e.g. `createMemoryStorageBackend()` for hermetic tests);
 * without one the governed default — `local-fs` over secure-io — applies, so
 * tier, tenant, symlink and audit checks are unchanged.
 */

import * as path from 'node:path';
import { resolveStorageBackend, type StorageBackend } from './storage/storage-backend.js';
import './storage/local-storage-backend.js';

export interface EntryLedgerOptions {
  /** How to handle corrupt lines on read. Default 'skip'. */
  onMalformed?: 'skip' | 'throw';
  /** Require the ledger file to be a regular file (symlink rejected). */
  requireRegularFile?: boolean;
  /** Persistence backend. Defaults to the governed seam resolution (local-fs). */
  backend?: StorageBackend;
}

export interface EntryLedger<T> {
  readonly path: string;
  /** Append one entry. The caller validates/shapes it first. */
  append(entry: T): T;
  /** Read all entries in append order; optional per-line map may drop rows by returning null. */
  readAll(map?: (value: unknown, lineNumber: number) => T | null): T[];
  exists(): boolean;
}

function assertRegularFile(backend: StorageBackend, filePath: string): void {
  const stat = backend.stat(filePath);
  if (stat === null) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`[ENTRY_LEDGER] ledger must be a regular file: ${filePath}`);
  }
}

export function createEntryLedger<T>(
  ledgerPath: string,
  options: EntryLedgerOptions = {}
): EntryLedger<T> {
  const { onMalformed = 'skip', requireRegularFile = true } = options;
  const backend = options.backend ?? resolveStorageBackend();

  const ensure = (): void => {
    if (requireRegularFile) assertRegularFile(backend, ledgerPath);
  };

  return {
    path: ledgerPath,
    append(entry: T): T {
      ensure();
      backend.mkdir(path.dirname(ledgerPath));
      backend.append(ledgerPath, `${JSON.stringify(entry)}\n`);
      return entry;
    },
    readAll(map?: (value: unknown, lineNumber: number) => T | null): T[] {
      if (!backend.exists(ledgerPath)) return [];
      ensure();
      const entries: T[] = [];
      for (const line of backend.readLines(ledgerPath)) {
        if (!line.text.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line.text);
        } catch (error) {
          if (onMalformed === 'throw') throw error;
          continue;
        }
        try {
          const entry = map ? map(value, line.lineNumber) : (value as T | null);
          if (entry !== null) entries.push(entry);
        } catch (error) {
          // readJsonLines parity: with onMalformed 'skip', a row rejected by the
          // caller's map (e.g. schema validate) is dropped like a corrupt line.
          if (onMalformed !== 'skip') throw error;
        }
      }
      return entries;
    },
    exists(): boolean {
      return backend.exists(ledgerPath);
    },
  };
}
